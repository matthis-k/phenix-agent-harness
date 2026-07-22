import {
  recordSessionExecutionEvent,
  registerSessionExecutionContext,
  sessionExecutionContextForChildRun,
  unregisterSessionExecutionContext,
} from "../journal/session-execution-journal-registry.ts";
import type {
  ChildCycleOutcome,
  ChildRun,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionNode,
  ChildSessionSpec,
  PiSessionReference,
} from "./child-session-types.ts";

function childActorId(spec: ChildSessionSpec): string {
  return spec.contract.runtime.workflow.actorId;
}

function parentActorId(spec: ChildSessionSpec): string {
  return spec.contract.runtime.workflow.parentActorId ?? "root";
}

function parentSessionId(spec: ChildSessionSpec): string {
  if (!spec.parentId) return spec.parentContext.sessionId;
  return (
    sessionExecutionContextForChildRun(spec.parentId)?.sessionId ?? spec.parentContext.sessionId
  );
}

function eventPayload(event: ChildSessionEvent): Readonly<Record<string, unknown>> {
  switch (event.type) {
    case "session.started":
      return { pi: event.pi };
    case "agent.event":
      return { event: event.event };
    case "tool.started":
      return { toolName: event.toolName };
    case "tool.completed":
      return { toolName: event.toolName, isError: event.isError };
    case "cycle.settled":
      return { cycle: event.cycle };
    case "session.failed":
      return { error: event.error };
    case "session.cancelled":
      return { reason: event.reason };
    case "session.disposed":
      return {};
  }
}

class JournaledChildRun implements ChildRun {
  readonly id: ChildRun["id"];
  readonly backend: ChildRun["backend"];

  private readonly delegate: ChildRun;
  private readonly spec: ChildSessionSpec;
  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  private readonly reportedCycles = new Set<number>();
  private readonly unsubscribeDelegate: () => void;

  constructor(delegate: ChildRun, spec: ChildSessionSpec) {
    this.delegate = delegate;
    this.spec = spec;
    this.id = delegate.id;
    this.backend = delegate.backend;
    this.registerCurrentSession();
    this.unsubscribeDelegate = delegate.subscribe((event) => {
      this.record(`child.${event.type}`, eventPayload(event));
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          // Journal projection listeners must not alter child execution.
        }
      }
    });
  }

  get pi(): PiSessionReference {
    return this.delegate.pi;
  }

  private registerCurrentSession(): void {
    registerSessionExecutionContext({
      cwd: this.spec.cwd,
      rootSessionId: this.spec.parentContext.sessionId,
      sessionId: this.delegate.pi.sessionId,
      actorId: childActorId(this.spec),
      parentSessionId: parentSessionId(this.spec),
      childRunId: this.spec.id,
    });
  }

  private record(type: string, payload?: Readonly<Record<string, unknown>>): void {
    this.registerCurrentSession();
    recordSessionExecutionEvent(this.spec.cwd, {
      rootSessionId: this.spec.parentContext.sessionId,
      sessionId: this.delegate.pi.sessionId,
      actorId: childActorId(this.spec),
      parentSessionId: parentSessionId(this.spec),
      objectiveId: this.spec.contract.runtime.workflow.instanceId,
      handleId: this.spec.handleId,
      childRunId: this.spec.id,
      type,
      ...(payload ? { payload } : {}),
    });
  }

  private reportOutcome(outcome: ChildCycleOutcome): void {
    if (this.reportedCycles.has(outcome.cycle)) return;
    this.reportedCycles.add(outcome.cycle);
    this.record("interaction.child_to_parent", {
      cycle: outcome.cycle,
      status: outcome.status,
      ...(outcome.lastAssistantText ? { message: outcome.lastAssistantText } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  snapshot(): ChildSessionNode {
    return this.delegate.snapshot();
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async continue(message: string, signal?: AbortSignal): Promise<ChildCycleOutcome> {
    recordSessionExecutionEvent(this.spec.cwd, {
      rootSessionId: this.spec.parentContext.sessionId,
      sessionId: parentSessionId(this.spec),
      actorId: parentActorId(this.spec),
      objectiveId: this.spec.contract.runtime.workflow.instanceId,
      handleId: this.spec.handleId,
      childRunId: this.spec.id,
      type: "interaction.parent_to_child",
      payload: { message, operation: "continue" },
    });
    const outcome = await this.delegate.continue(message, signal);
    this.reportOutcome(outcome);
    return outcome;
  }

  async waitForCurrentCycle(signal?: AbortSignal): Promise<ChildCycleOutcome> {
    const outcome = await this.delegate.waitForCurrentCycle(signal);
    this.reportOutcome(outcome);
    return outcome;
  }

  async abort(reason: string): Promise<void> {
    recordSessionExecutionEvent(this.spec.cwd, {
      rootSessionId: this.spec.parentContext.sessionId,
      sessionId: parentSessionId(this.spec),
      actorId: parentActorId(this.spec),
      objectiveId: this.spec.contract.runtime.workflow.instanceId,
      handleId: this.spec.handleId,
      childRunId: this.spec.id,
      type: "interaction.parent_to_child",
      payload: { operation: "abort", reason },
    });
    await this.delegate.abort(reason);
  }

  async dispose(): Promise<void> {
    try {
      await this.delegate.dispose();
    } finally {
      this.unsubscribeDelegate();
      this.listeners.clear();
      unregisterSessionExecutionContext(this.delegate.pi.sessionId);
    }
  }
}

/** Root-owned observer around either SDK or RPC child execution. */
export class JournaledChildSessionBackend implements ChildSessionBackend {
  readonly kind: ChildSessionBackend["kind"];

  private readonly delegate: ChildSessionBackend;

  constructor(delegate: ChildSessionBackend) {
    this.delegate = delegate;
    this.kind = delegate.kind;
  }

  async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
    const parentSession = parentSessionId(spec);
    recordSessionExecutionEvent(spec.cwd, {
      rootSessionId: spec.parentContext.sessionId,
      sessionId: parentSession,
      actorId: parentActorId(spec),
      objectiveId: spec.contract.runtime.workflow.instanceId,
      handleId: spec.handleId,
      childRunId: spec.id,
      type: "interaction.delegation.requested",
      payload: {
        toActorId: childActorId(spec),
        role: spec.role,
        backendPreference: spec.isolationRequired ? "rpc" : "sdk",
        task: spec.initialPrompt,
        requirements: spec.contract.assignment.requirements,
        ...(spec.parentId ? { parentChildRunId: spec.parentId } : {}),
      },
    });

    try {
      const run = await this.delegate.start(spec, signal);
      const journaled = new JournaledChildRun(run, spec);
      recordSessionExecutionEvent(spec.cwd, {
        rootSessionId: spec.parentContext.sessionId,
        sessionId: run.pi.sessionId,
        actorId: childActorId(spec),
        parentSessionId: parentSession,
        objectiveId: spec.contract.runtime.workflow.instanceId,
        handleId: spec.handleId,
        childRunId: spec.id,
        type: "child.session.started",
        payload: {
          backend: run.backend,
          piSessionId: run.pi.sessionId,
          ...(run.pi.sessionFile ? { sessionFile: run.pi.sessionFile } : {}),
          role: spec.role,
          model: spec.model,
          assurance: spec.assurance,
          isolationRequired: spec.isolationRequired ?? false,
        },
      });
      return journaled;
    } catch (error) {
      recordSessionExecutionEvent(spec.cwd, {
        rootSessionId: spec.parentContext.sessionId,
        sessionId: parentSession,
        actorId: parentActorId(spec),
        objectiveId: spec.contract.runtime.workflow.instanceId,
        handleId: spec.handleId,
        childRunId: spec.id,
        type: "child.session.start_failed",
        payload: { error },
      });
      throw error;
    }
  }
}

export function createJournaledChildSessionBackend(
  delegate: ChildSessionBackend,
): JournaledChildSessionBackend {
  return new JournaledChildSessionBackend(delegate);
}
