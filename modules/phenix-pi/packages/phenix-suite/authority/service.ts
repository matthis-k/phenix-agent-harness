import { randomUUID } from "node:crypto";

import type { TaskStatus } from "@matthis-k/phenix-tasks/facade.ts";
import type { ExecutionAuthorityStore } from "./store.ts";
import type {
  AcceptanceDecision,
  AuthorityMutation,
  BeginObjectiveInput,
  CreateNodeInput,
  ExecutionAuthorityEvent,
  ExecutionAuthorityEventType,
  ExecutionAuthorityPersistence,
  ExecutionAuthoritySnapshot,
  ExecutionHandleRecord,
  ExecutionNodeRecord,
  LegalAction,
  ObjectiveRecord,
  RegisterHandleInput,
  RuntimeHandleUpdate,
} from "./types.ts";

const TERMINAL_OBJECTIVE_STATES = new Set(["completed", "failed", "discarded"]);
const TERMINAL_RUNTIME_STATES = new Set(["failed", "cancelled", "orphaned"]);
const TERMINAL_ACCEPTANCE_STATES = new Set(["accepted", "rejected", "cancelled"]);

export interface ExecutionAuthorityOptions {
  readonly store: ExecutionAuthorityStore;
  readonly maximumDelegationDepth?: number;
  readonly maximumActiveChildren?: number;
}

export interface TaskProjectionInput {
  readonly objectiveId: string;
  readonly taskUid: string;
  readonly parentTaskUid?: string;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly actorId: string;
}

function now(): string {
  return new Date().toISOString();
}

function compact(value: string, maximum = 500): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function fingerprint(operation: string, input: unknown): string {
  return JSON.stringify([operation, input]);
}

function isObjectiveTerminal(objective: ObjectiveRecord): boolean {
  return TERMINAL_OBJECTIVE_STATES.has(objective.state);
}

function taskState(status: TaskStatus): ExecutionNodeRecord["state"] {
  if (status === "done") return "accepted";
  if (status === "wip") return "running";
  return "pending";
}

export class ExecutionAuthority {
  private state: ExecutionAuthorityPersistence;
  private readonly store: ExecutionAuthorityStore;
  private readonly maximumDelegationDepth: number;
  private readonly maximumActiveChildren: number;
  private readonly listeners = new Set<(event: ExecutionAuthorityEvent) => void>();
  private readonly activeCountListeners = new Set<(activeCount: number) => void>();

  constructor(options: ExecutionAuthorityOptions) {
    this.store = options.store;
    this.maximumDelegationDepth = options.maximumDelegationDepth ?? 2;
    this.maximumActiveChildren = options.maximumActiveChildren ?? 8;
    this.state = this.store.load();
  }

  get activeCount(): number {
    return this.state.handles.filter(
      (handle) =>
        !TERMINAL_RUNTIME_STATES.has(handle.runtimeState) &&
        !TERMINAL_ACCEPTANCE_STATES.has(handle.acceptanceState),
    ).length;
  }

  subscribe(listener: (event: ExecutionAuthorityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeActiveCount(listener: (activeCount: number) => void): () => void {
    this.activeCountListeners.add(listener);
    return () => this.activeCountListeners.delete(listener);
  }

  eventsAfter(sequence: number, objectiveId?: string): readonly ExecutionAuthorityEvent[] {
    return this.state.events.filter(
      (event) => event.sequence > sequence && (!objectiveId || event.objectiveId === objectiveId),
    );
  }

  activeObjectiveForSession(sessionId: string): ObjectiveRecord | undefined {
    return this.state.objectives.find(
      (objective) => objective.rootSessionId === sessionId && !isObjectiveTerminal(objective),
    );
  }

  inspectObjective(objectiveId: string): ExecutionAuthoritySnapshot {
    const objective = this.requireObjective(objectiveId);
    return {
      sequence: this.state.sequence,
      objective,
      nodes: this.state.nodes.filter((node) => node.objectiveId === objectiveId),
      handles: this.state.handles.filter((handle) => handle.objectiveId === objectiveId),
      legalActions: this.state.legalActionsByObjective[objectiveId] ?? [],
    };
  }

  beginObjective(input: BeginObjectiveInput, mutation: AuthorityMutation): ObjectiveRecord {
    return this.mutate("beginObjective", mutation, input, () => {
      const active = this.activeObjectiveForSession(input.rootSessionId);
      if (active) {
        throw new Error(
          `Session ${input.rootSessionId} already owns active objective ${active.id}; amend, resume, or discard it first.`,
        );
      }
      const timestamp = now();
      const objectiveId = input.id ?? `objective_${randomUUID()}`;
      if (this.state.objectives.some((objective) => objective.id === objectiveId)) {
        throw new Error(`Objective already exists: ${objectiveId}`);
      }
      const rootNodeId = `node_${randomUUID()}`;
      const objective: ObjectiveRecord = {
        id: objectiveId,
        rootSessionId: input.rootSessionId,
        rootActorId: input.rootActorId,
        userTask: compact(input.userTask, 4_000),
        workflowDefinitionId: input.workflowDefinitionId,
        difficulty: input.difficulty,
        assurance: input.assurance,
        state: "active",
        rootNodeId,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const rootNode: ExecutionNodeRecord = {
        id: rootNodeId,
        objectiveId,
        purpose: "coordinate",
        assignment: objective.userTask,
        requirements: [],
        role: "coordinator",
        assurance: input.assurance,
        depth: 0,
        dependencies: [],
        state: "running",
        attempt: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state = {
        ...this.state,
        objectives: [...this.state.objectives, objective],
        nodes: [...this.state.nodes, rootNode],
      };
      this.recordEvent(objective, "objective.started", mutation.actorId, {
        data: {
          workflowDefinitionId: input.workflowDefinitionId,
          difficulty: input.difficulty,
          assurance: input.assurance,
        },
      });
      return objective;
    });
  }

  resumeObjective(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord {
    return this.mutate("resumeObjective", mutation, { objectiveId }, () => {
      const current = this.requireObjective(objectiveId);
      if (isObjectiveTerminal(current)) {
        throw new Error(`Terminal objective ${objectiveId} cannot be resumed.`);
      }
      if (current.state === "active") return current;
      const updated = this.updateObjective(current, { state: "active" });
      this.recordEvent(updated, "objective.resumed", mutation.actorId);
      return updated;
    });
  }

  pauseObjective(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord {
    return this.mutate("pauseObjective", mutation, { objectiveId }, () => {
      const current = this.requireObjective(objectiveId);
      this.requireExpectedRevision(current, mutation);
      if (isObjectiveTerminal(current)) throw new Error(`Objective ${objectiveId} is terminal.`);
      const updated = this.updateObjective(current, { state: "paused" });
      this.recordEvent(updated, "objective.paused", mutation.actorId);
      return updated;
    });
  }

  amendObjective(
    objectiveId: string,
    amendment: string,
    mutation: AuthorityMutation,
  ): ObjectiveRecord {
    return this.mutate("amendObjective", mutation, { objectiveId, amendment }, () => {
      const current = this.requireObjective(objectiveId);
      this.requireExpectedRevision(current, mutation);
      if (isObjectiveTerminal(current)) throw new Error(`Objective ${objectiveId} is terminal.`);
      const normalized = compact(amendment, 4_000);
      if (!normalized) throw new Error("Objective amendment cannot be empty.");
      const updated = this.updateObjective(current, {
        latestAmendment: normalized,
        state: "active",
      });
      this.recordEvent(updated, "objective.amended", mutation.actorId, {
        data: { amendment: normalized },
      });
      return updated;
    });
  }

  discardObjective(
    objectiveId: string,
    reason: string,
    mutation: AuthorityMutation,
  ): ObjectiveRecord {
    return this.mutate("discardObjective", mutation, { objectiveId, reason }, () => {
      const current = this.requireObjective(objectiveId);
      this.requireExpectedRevision(current, mutation);
      if (isObjectiveTerminal(current)) return current;
      const timestamp = now();
      const updated = this.updateObjective(current, {
        state: "discarded",
        failure: compact(reason),
        terminalAt: timestamp,
      });
      this.state = {
        ...this.state,
        nodes: this.state.nodes.map((node) =>
          node.objectiveId === objectiveId && !this.isNodeTerminal(node)
            ? { ...node, state: "cancelled", failure: compact(reason), updatedAt: timestamp }
            : node,
        ),
        handles: this.state.handles.map((handle) =>
          handle.objectiveId === objectiveId &&
          !TERMINAL_ACCEPTANCE_STATES.has(handle.acceptanceState)
            ? {
                ...handle,
                runtimeState: "cancelled",
                acceptanceState: "cancelled",
                errors: [compact(reason)],
                settledAt: timestamp,
                updatedAt: timestamp,
              }
            : handle,
        ),
        legalActionsByObjective: {
          ...this.state.legalActionsByObjective,
          [objectiveId]: [],
        },
      };
      this.recordEvent(updated, "objective.discarded", mutation.actorId, {
        data: { reason: compact(reason) },
      });
      this.recordEvent(updated, "capability.revoked", mutation.actorId, {
        data: { reason: "objective-discarded" },
      });
      return updated;
    });
  }

  completeObjective(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord {
    return this.mutate("completeObjective", mutation, { objectiveId }, () => {
      const current = this.requireObjective(objectiveId);
      this.requireExpectedRevision(current, mutation);
      const unfinished = this.state.nodes.filter(
        (node) =>
          node.objectiveId === objectiveId &&
          node.id !== current.rootNodeId &&
          !this.isNodeTerminal(node),
      );
      if (unfinished.length > 0) {
        throw new Error(
          `Objective ${objectiveId} cannot complete with ${unfinished.length} non-terminal node(s).`,
        );
      }
      const rejected = this.state.nodes.filter(
        (node) =>
          node.objectiveId === objectiveId &&
          ["rejected", "failed", "orphaned"].includes(node.state),
      );
      if (rejected.length > 0) {
        throw new Error(`Objective ${objectiveId} contains rejected or failed execution nodes.`);
      }
      const timestamp = now();
      const updated = this.updateObjective(current, { state: "completed", terminalAt: timestamp });
      this.state = {
        ...this.state,
        nodes: this.state.nodes.map((node) =>
          node.id === current.rootNodeId
            ? { ...node, state: "accepted", acceptedAt: timestamp, updatedAt: timestamp }
            : node,
        ),
        legalActionsByObjective: {
          ...this.state.legalActionsByObjective,
          [objectiveId]: [],
        },
      };
      this.recordEvent(updated, "objective.completed", mutation.actorId);
      return updated;
    });
  }

  failObjective(objectiveId: string, reason: string, mutation: AuthorityMutation): ObjectiveRecord {
    return this.mutate("failObjective", mutation, { objectiveId, reason }, () => {
      const current = this.requireObjective(objectiveId);
      this.requireExpectedRevision(current, mutation);
      if (isObjectiveTerminal(current)) return current;
      const timestamp = now();
      const updated = this.updateObjective(current, {
        state: "failed",
        failure: compact(reason),
        terminalAt: timestamp,
      });
      this.state = {
        ...this.state,
        legalActionsByObjective: { ...this.state.legalActionsByObjective, [objectiveId]: [] },
      };
      this.recordEvent(updated, "objective.failed", mutation.actorId, {
        data: { reason: compact(reason) },
      });
      return updated;
    });
  }

  syncLegalActions(objectiveId: string, actions: readonly LegalAction[], actorId: string): void {
    const current = this.requireObjective(objectiveId);
    if (isObjectiveTerminal(current)) return;
    const normalized = [...actions].sort((left, right) => left.id.localeCompare(right.id));
    const existing = [...(this.state.legalActionsByObjective[objectiveId] ?? [])].sort(
      (left, right) => left.id.localeCompare(right.id),
    );
    if (JSON.stringify(existing) === JSON.stringify(normalized)) return;
    const beforeEvents = this.state.events.length;
    const updated = this.updateObjective(current, {});
    this.state = {
      ...this.state,
      legalActionsByObjective: {
        ...this.state.legalActionsByObjective,
        [objectiveId]: normalized,
      },
    };
    this.recordEvent(updated, "authority.actions.changed", actorId, {
      data: { actionIds: normalized.map((action) => action.id) },
    });
    this.persistAndNotify(beforeEvents, this.activeCount);
  }

  createNode(input: CreateNodeInput, mutation: AuthorityMutation): ExecutionNodeRecord {
    return this.mutate("createNode", mutation, input, () => {
      const objective = this.requireObjective(input.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      if (objective.state !== "active") {
        throw new Error(`Objective ${objective.id} is not active.`);
      }
      const parent = input.parentNodeId
        ? this.requireNode(input.parentNodeId)
        : this.requireNode(objective.rootNodeId);
      if (parent.objectiveId !== objective.id)
        throw new Error("Parent node belongs to another objective.");
      const depth = parent.depth + 1;
      if (depth > this.maximumDelegationDepth) {
        throw new Error(
          `Delegation depth ${depth} exceeds maximum ${this.maximumDelegationDepth}.`,
        );
      }
      const activeChildren = this.state.nodes.filter(
        (node) => node.parentNodeId === parent.id && !this.isNodeTerminal(node),
      );
      if (activeChildren.length >= this.maximumActiveChildren) {
        throw new Error(
          `Node ${parent.id} already owns the maximum ${this.maximumActiveChildren} active children.`,
        );
      }
      const dependencies = [...new Set(input.dependencies ?? [])];
      for (const dependencyId of dependencies) {
        const dependency = this.requireNode(dependencyId);
        if (dependency.objectiveId !== objective.id) {
          throw new Error(`Dependency ${dependencyId} belongs to another objective.`);
        }
      }
      const timestamp = now();
      const node: ExecutionNodeRecord = {
        id: `node_${randomUUID()}`,
        objectiveId: objective.id,
        parentNodeId: parent.id,
        ...(input.taskUid ? { taskUid: input.taskUid } : {}),
        ...(input.actionId ? { actionId: input.actionId } : {}),
        purpose: compact(input.purpose),
        assignment: compact(input.assignment, 8_000),
        requirements: (input.requirements ?? []).map((requirement) => compact(requirement, 1_000)),
        ...(input.role ? { role: input.role } : {}),
        ...(input.outputSchemaId ? { outputSchemaId: input.outputSchemaId } : {}),
        assurance: input.assurance ?? objective.assurance,
        depth,
        dependencies,
        state: dependencies.length > 0 ? "pending" : "ready",
        attempt: input.attempt ?? 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state = {
        ...this.state,
        nodes: [...this.state.nodes, node],
      };
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "node.created", mutation.actorId, {
        nodeId: node.id,
        data: { actionId: node.actionId, role: node.role, assurance: node.assurance },
      });
      return node;
    });
  }

  projectTask(input: TaskProjectionInput): ExecutionNodeRecord {
    const objective = this.requireObjective(input.objectiveId);
    const beforeEvents = this.state.events.length;
    const previousActiveCount = this.activeCount;
    const existing = this.state.nodes.find(
      (node) => node.objectiveId === input.objectiveId && node.taskUid === input.taskUid,
    );
    const parent = input.parentTaskUid
      ? this.state.nodes.find(
          (node) => node.objectiveId === input.objectiveId && node.taskUid === input.parentTaskUid,
        )
      : this.requireNode(objective.rootNodeId);
    const timestamp = now();
    let projected: ExecutionNodeRecord;
    if (existing) {
      projected = {
        ...existing,
        assignment: compact(input.description ?? input.title, 8_000),
        state: taskState(input.status),
        updatedAt: timestamp,
        ...(input.status === "done" ? { acceptedAt: timestamp } : {}),
      };
      this.replaceNode(projected);
    } else {
      projected = {
        id: `node_${randomUUID()}`,
        objectiveId: input.objectiveId,
        parentNodeId: parent?.id ?? objective.rootNodeId,
        taskUid: input.taskUid,
        purpose: "task",
        assignment: compact(input.description ?? input.title, 8_000),
        requirements: [],
        assurance: objective.assurance,
        depth: (parent?.depth ?? 0) + 1,
        dependencies: [],
        state: taskState(input.status),
        attempt: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.status === "done" ? { acceptedAt: timestamp } : {}),
      };
      this.state = { ...this.state, nodes: [...this.state.nodes, projected] };
    }
    const updatedObjective = this.updateObjective(objective, {});
    this.recordEvent(updatedObjective, existing ? "node.updated" : "node.created", input.actorId, {
      nodeId: projected.id,
      data: { taskUid: input.taskUid, taskStatus: input.status },
    });
    this.persistAndNotify(beforeEvents, previousActiveCount);
    return projected;
  }

  registerHandle(input: RegisterHandleInput, mutation: AuthorityMutation): ExecutionHandleRecord {
    return this.mutate("registerHandle", mutation, input, () => {
      const objective = this.requireObjective(input.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      const node = this.requireNode(input.nodeId);
      if (node.objectiveId !== objective.id)
        throw new Error("Handle node belongs to another objective.");
      const existing = this.state.handles.find((handle) => handle.id === input.id);
      if (existing) return existing;
      const timestamp = now();
      const handle: ExecutionHandleRecord = {
        id: input.id,
        objectiveId: objective.id,
        nodeId: node.id,
        attempt: input.attempt ?? node.attempt,
        mode: input.mode,
        runtimeState: "created",
        acceptanceState: "pending",
        ...(input.childRunId ? { childRunId: input.childRunId } : {}),
        ...(input.piSessionId ? { piSessionId: input.piSessionId } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state = {
        ...this.state,
        handles: [...this.state.handles, handle],
      };
      this.replaceNode({ ...node, state: "starting", updatedAt: timestamp });
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "handle.created", mutation.actorId, {
        nodeId: node.id,
        handleId: handle.id,
        data: { mode: handle.mode },
      });
      return handle;
    });
  }

  updateHandleRuntime(
    handleId: string,
    update: RuntimeHandleUpdate,
    mutation: AuthorityMutation,
  ): ExecutionHandleRecord {
    return this.mutate("updateHandleRuntime", mutation, { handleId, update }, () => {
      const handle = this.requireHandle(handleId);
      const objective = this.requireObjective(handle.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      const timestamp = now();
      const updated: ExecutionHandleRecord = {
        ...handle,
        runtimeState: update.runtimeState,
        ...(update.childRunId ? { childRunId: update.childRunId } : {}),
        ...(update.piSessionId ? { piSessionId: update.piSessionId } : {}),
        ...(update.errors ? { errors: [...update.errors] } : {}),
        ...(update.runtimeState === "settled" || TERMINAL_RUNTIME_STATES.has(update.runtimeState)
          ? { settledAt: timestamp }
          : {}),
        updatedAt: timestamp,
      };
      this.replaceHandle(updated);
      const node = this.requireNode(handle.nodeId);
      const nodeState: ExecutionNodeRecord["state"] =
        update.runtimeState === "running" || update.runtimeState === "waiting"
          ? "running"
          : update.runtimeState === "failed"
            ? "failed"
            : update.runtimeState === "cancelled"
              ? "cancelled"
              : update.runtimeState === "orphaned"
                ? "orphaned"
                : node.state;
      this.replaceNode({
        ...node,
        state: nodeState,
        ...(update.errors?.length ? { failure: update.errors.join(" | ") } : {}),
        updatedAt: timestamp,
      });
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "handle.runtime.changed", mutation.actorId, {
        nodeId: node.id,
        handleId: handle.id,
        data: { runtimeState: update.runtimeState },
      });
      return updated;
    });
  }

  submitResult(
    handleId: string,
    value: unknown,
    mutation: AuthorityMutation,
  ): ExecutionHandleRecord {
    return this.mutate("submitResult", mutation, { handleId, value }, () => {
      const handle = this.requireHandle(handleId);
      const objective = this.requireObjective(handle.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      if (handle.acceptanceState === "accepted") return handle;
      const timestamp = now();
      const updated: ExecutionHandleRecord = {
        ...handle,
        runtimeState: "settled",
        acceptanceState: "submitted",
        value,
        settledAt: handle.settledAt ?? timestamp,
        updatedAt: timestamp,
      };
      this.replaceHandle(updated);
      const node = this.requireNode(handle.nodeId);
      this.replaceNode({ ...node, state: "submitted", updatedAt: timestamp });
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "result.submitted", mutation.actorId, {
        nodeId: node.id,
        handleId: handle.id,
      });
      return updated;
    });
  }

  beginVerification(handleId: string, mutation: AuthorityMutation): ExecutionHandleRecord {
    return this.mutate("beginVerification", mutation, { handleId }, () => {
      const handle = this.requireHandle(handleId);
      const objective = this.requireObjective(handle.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      if (handle.acceptanceState !== "submitted") {
        throw new Error(`Handle ${handleId} has no submitted result to verify.`);
      }
      const timestamp = now();
      const updated = { ...handle, acceptanceState: "verifying" as const, updatedAt: timestamp };
      this.replaceHandle(updated);
      const node = this.requireNode(handle.nodeId);
      this.replaceNode({ ...node, state: "verifying", updatedAt: timestamp });
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "verification.started", mutation.actorId, {
        nodeId: node.id,
        handleId: handle.id,
      });
      return updated;
    });
  }

  decideAcceptance(
    handleId: string,
    decision: AcceptanceDecision,
    mutation: AuthorityMutation,
  ): ExecutionHandleRecord {
    return this.mutate("decideAcceptance", mutation, { handleId, decision }, () => {
      const handle = this.requireHandle(handleId);
      const objective = this.requireObjective(handle.objectiveId);
      this.requireExpectedRevision(objective, mutation);
      const node = this.requireNode(handle.nodeId);
      const timestamp = now();
      const acceptanceState = decision.outcome;
      const nodeState: ExecutionNodeRecord["state"] =
        decision.outcome === "accepted"
          ? "accepted"
          : decision.outcome === "inconclusive"
            ? "repairable"
            : decision.repairAllowed
              ? "repairable"
              : "rejected";
      const updated: ExecutionHandleRecord = {
        ...handle,
        runtimeState: handle.runtimeState === "settled" ? "settled" : handle.runtimeState,
        acceptanceState,
        ...(decision.value !== undefined ? { value: decision.value } : {}),
        ...(decision.errors ? { errors: [...decision.errors] } : {}),
        ...(decision.verificationEvidence !== undefined
          ? { verificationEvidence: decision.verificationEvidence }
          : {}),
        ...(decision.outcome === "accepted" ? { acceptedAt: timestamp } : {}),
        updatedAt: timestamp,
      };
      this.replaceHandle(updated);
      this.replaceNode({
        ...node,
        state: nodeState,
        ...(decision.outcome === "accepted" ? { acceptedAt: timestamp } : {}),
        ...(decision.errors?.length ? { failure: decision.errors.join(" | ") } : {}),
        updatedAt: timestamp,
      });
      const updatedObjective = this.updateObjective(objective, {});
      this.recordEvent(updatedObjective, "acceptance.decided", mutation.actorId, {
        nodeId: node.id,
        handleId: handle.id,
        data: { outcome: decision.outcome, repairAllowed: decision.repairAllowed ?? false },
      });
      return updated;
    });
  }

  recoverHandle(
    handleId: string,
    runtimeState: RuntimeHandleUpdate["runtimeState"],
    actorId: string,
  ): ExecutionHandleRecord {
    const handle = this.requireHandle(handleId);
    const beforeEvents = this.state.events.length;
    const previousActiveCount = this.activeCount;
    const objective = this.requireObjective(handle.objectiveId);
    const timestamp = now();
    const updated = {
      ...handle,
      runtimeState,
      ...(runtimeState === "orphaned" ? { errors: ["Runtime could not be reattached."] } : {}),
      updatedAt: timestamp,
    };
    this.replaceHandle(updated);
    const node = this.requireNode(handle.nodeId);
    this.replaceNode({
      ...node,
      state: runtimeState === "orphaned" ? "orphaned" : node.state,
      updatedAt: timestamp,
    });
    const updatedObjective = this.updateObjective(objective, {});
    this.recordEvent(updatedObjective, "recovery.performed", actorId, {
      nodeId: node.id,
      handleId,
      data: { runtimeState },
    });
    this.persistAndNotify(beforeEvents, previousActiveCount);
    return updated;
  }

  private mutate<T>(
    operation: string,
    mutation: AuthorityMutation,
    input: unknown,
    execute: () => T,
  ): T {
    const key = `${operation}:${mutation.idempotencyKey}`;
    const expectedFingerprint = fingerprint(operation, input);
    const existing = this.state.idempotency[key];
    if (existing) {
      if (existing.fingerprint !== expectedFingerprint) {
        throw new Error(
          `Idempotency key ${mutation.idempotencyKey} was reused with different input.`,
        );
      }
      return structuredClone(existing.value) as T;
    }

    const previous = structuredClone(this.state);
    const beforeEvents = this.state.events.length;
    const previousActiveCount = this.activeCount;
    try {
      const value = execute();
      this.state = {
        ...this.state,
        idempotency: {
          ...this.state.idempotency,
          [key]: { fingerprint: expectedFingerprint, value: structuredClone(value) },
        },
      };
      this.persistAndNotify(beforeEvents, previousActiveCount);
      return structuredClone(value);
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  private persistAndNotify(beforeEvents: number, previousActiveCount: number): void {
    this.store.save(this.state);
    for (const event of this.state.events.slice(beforeEvents)) {
      for (const listener of this.listeners) listener(event);
    }
    const activeCount = this.activeCount;
    if (activeCount !== previousActiveCount) {
      for (const listener of this.activeCountListeners) listener(activeCount);
    }
  }

  private recordEvent(
    objective: ObjectiveRecord,
    type: ExecutionAuthorityEventType,
    actorId: string,
    input: {
      readonly nodeId?: string;
      readonly handleId?: string;
      readonly data?: Readonly<Record<string, unknown>>;
    } = {},
  ): void {
    const sequence = this.state.sequence + 1;
    const event: ExecutionAuthorityEvent = {
      id: `event_${randomUUID()}`,
      objectiveId: objective.id,
      sequence,
      revision: objective.revision,
      timestamp: now(),
      type,
      actorId,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.handleId ? { handleId: input.handleId } : {}),
      ...(input.data ? { data: input.data } : {}),
    };
    this.state = {
      ...this.state,
      sequence,
      events: [...this.state.events, event],
    };
  }

  private updateObjective(
    current: ObjectiveRecord,
    patch: Partial<Pick<ObjectiveRecord, "state" | "latestAmendment" | "terminalAt" | "failure">>,
  ): ObjectiveRecord {
    const updated: ObjectiveRecord = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: now(),
    };
    this.state = {
      ...this.state,
      objectives: this.state.objectives.map((objective) =>
        objective.id === updated.id ? updated : objective,
      ),
    };
    return updated;
  }

  private replaceNode(updated: ExecutionNodeRecord): void {
    this.state = {
      ...this.state,
      nodes: this.state.nodes.map((node) => (node.id === updated.id ? updated : node)),
    };
  }

  private replaceHandle(updated: ExecutionHandleRecord): void {
    this.state = {
      ...this.state,
      handles: this.state.handles.map((handle) => (handle.id === updated.id ? updated : handle)),
    };
  }

  private requireObjective(objectiveId: string): ObjectiveRecord {
    const objective = this.state.objectives.find((candidate) => candidate.id === objectiveId);
    if (!objective) throw new Error(`Unknown objective: ${objectiveId}`);
    return objective;
  }

  private requireNode(nodeId: string): ExecutionNodeRecord {
    const node = this.state.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Unknown execution node: ${nodeId}`);
    return node;
  }

  private requireHandle(handleId: string): ExecutionHandleRecord {
    const handle = this.state.handles.find((candidate) => candidate.id === handleId);
    if (!handle) throw new Error(`Unknown execution handle: ${handleId}`);
    return handle;
  }

  private requireExpectedRevision(objective: ObjectiveRecord, mutation: AuthorityMutation): void {
    if (
      mutation.expectedRevision !== undefined &&
      mutation.expectedRevision !== objective.revision
    ) {
      throw new Error(
        `Stale objective revision for ${objective.id}: expected ${mutation.expectedRevision}, current ${objective.revision}.`,
      );
    }
  }

  private isNodeTerminal(node: ExecutionNodeRecord): boolean {
    return ["accepted", "rejected", "failed", "cancelled", "orphaned"].includes(node.state);
  }
}

export function createExecutionAuthority(options: ExecutionAuthorityOptions): ExecutionAuthority {
  return new ExecutionAuthority(options);
}
