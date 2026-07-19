import { randomUUID } from "node:crypto";
import type { AgentRole } from "@matthis-k/phenix-kernel/agents.ts";
import type { AgentCapabilityArtifact } from "./agent-capabilities.ts";
import { readCapabilityArtifact } from "./agent-capabilities.ts";
import { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "./runtime-policy.ts";
import {
  requireSessionCapabilityArtifact,
  requireSessionWorkflowData,
} from "./session-registry.ts";
import type { TransitionAuthority } from "./transition-authority.ts";
import { conditionSatisfied } from "./workflow-conditions.ts";
import { requireWorkflowDefinition } from "./workflow-definitions.ts";
import { factsFromTransitionResult, transitionMatchesDifficulty } from "./workflow-reducer.ts";
import {
  acceptTransition,
  mutateWorkflowRecord,
  now,
  readWorkflowRecord,
  rejectTransition,
} from "./workflow-store.ts";
import type {
  DelegationAuthority,
  WorkflowContractArtifact,
  WorkflowDefinition,
  WorkflowHandleRecord,
  WorkflowHandleStorePort,
  WorkflowRuntimeRecord,
  WorkflowStateId,
} from "./workflow-types.ts";
import { roleForAgentClient } from "./workflow-types.ts";

export interface WorkflowRuntimeDependencies {
  readonly definition: WorkflowDefinition;
  readonly record: WorkflowRuntimeRecord;
  readonly capabilities: AgentCapabilityArtifact;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly WorkflowHandleRecord[];
}

export type WorkflowActorSource =
  | { readonly kind: "root"; readonly sessionId: string }
  | { readonly kind: "child"; readonly contract: WorkflowContractArtifact };

export function buildWorkflowRuntimeDependencies(input: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly source: WorkflowActorSource;
  readonly handleStore: WorkflowHandleStorePort;
}): WorkflowRuntimeDependencies {
  return input.source.kind === "root"
    ? buildRootDependencies(input.cwd, input.source.sessionId, input.handleStore)
    : buildChildDependencies(input.cwd, input.source.contract, input.handleStore);
}

function buildRootDependencies(
  cwd: string,
  sessionId: string,
  handleStore: WorkflowHandleStorePort,
): WorkflowRuntimeDependencies {
  const workflowData = requireSessionWorkflowData(sessionId);
  const capabilities = requireSessionCapabilityArtifact(sessionId);
  const record = readWorkflowRecord(cwd, workflowData.instanceId, workflowData.actorId);
  if (!record) {
    throw new Error(
      `Root workflow record not found for ${workflowData.instanceId}/${workflowData.actorId}`,
    );
  }
  const availableRoles = capabilities.entries
    .filter((entry) => entry.spawnable)
    .map((entry) => entry.role);
  const authority: DelegationAuthority = {
    roles: {
      role: null,
      source: {
        inherited: false,
        patch: { additional: [], removed: [] },
      },
      effective: [...availableRoles],
    },
    availableRoles: [...availableRoles],
    remainingDepth: DEFAULT_MAXIMUM_DELEGATION_DEPTH,
    transitionAuthority: { kind: "unrestricted" },
  };
  const activeHandles = handleStore
    .listRecords(cwd, sessionId)
    .filter(
      (handle) =>
        handle.status === "running" &&
        handle.workflowBinding?.instanceId === record.instanceId &&
        handle.workflowBinding.actorId === record.actorId,
    );
  return {
    definition: requireWorkflowDefinition(record.definitionId),
    record,
    capabilities,
    authority,
    activeHandles,
  };
}

function buildChildDependencies(
  cwd: string,
  contract: WorkflowContractArtifact,
  handleStore: WorkflowHandleStorePort,
): WorkflowRuntimeDependencies {
  const workflow = contract.runtime.workflow;
  const record = readWorkflowRecord(cwd, workflow.instanceId, workflow.actorId);
  if (!record) {
    throw new Error(
      `Child workflow record not found for ${workflow.instanceId}/${workflow.actorId}`,
    );
  }
  const capabilities = readCapabilityArtifact(cwd, workflow.capabilityArtifactHash);
  const authority: DelegationAuthority = {
    roles: structuredClone(contract.runtime.delegation.roles),
    availableRoles: [...contract.runtime.delegation.availableRoles],
    remainingDepth: contract.runtime.delegation.remainingDepth,
    transitionAuthority: structuredClone(workflow.transitionAuthority),
  };
  const activeHandles = handleStore
    .listRecords(cwd, record.sessionId)
    .filter(
      (handle) =>
        handle.status === "running" &&
        handle.workflowBinding?.instanceId === record.instanceId &&
        handle.workflowBinding.actorId === record.actorId,
    );
  return {
    definition: requireWorkflowDefinition(record.definitionId),
    record,
    capabilities,
    authority,
    activeHandles,
  };
}

export function initialWorkflowStateForRole(role: AgentRole): WorkflowStateId {
  switch (role) {
    case null:
      return "executing";
    case "scout":
      return "scouting";
    case "planner":
      return "planning";
    case "architect":
      return "designing";
    case "implementer":
      return "implementing";
    case "tester":
      return "testing";
    case "critic":
      return "reviewing";
    case "finalizer":
      return "finalizing";
    default:
      return role;
  }
}

export function transitionAuthorityForChild(input: {
  readonly definition: WorkflowDefinition;
  readonly role: AgentRole;
  readonly initialState: WorkflowStateId;
  readonly authorizedRoles: readonly AgentRole[];
}): TransitionAuthority {
  const actorRole = input.role === null ? "base" : input.role;
  const allowed = input.definition.transitions
    .filter((transition) => transition.kind === "delegate")
    .filter((transition) => transition.scope !== "root")
    .filter((transition) => transition.actorRoles.includes(actorRole as never))
    .filter((transition) => transition.from.includes(input.initialState))
    .filter((transition) =>
      input.authorizedRoles.includes(roleForAgentClient(transition.agentClient)),
    )
    .map((transition) => transition.id);
  return { kind: "restricted", allowed };
}

function conditionContext(record: WorkflowRuntimeRecord) {
  return {
    difficulty: record.difficulty,
    profile: record.taskProfile,
    facts: record.facts,
    completedTransitionIds: new Set(record.completed.map((item) => item.transitionId)),
    activeTransitionIds: new Set(record.active.map((item) => item.transitionId)),
  };
}

export function applyAutomaticTransitions(input: {
  readonly cwd: string;
  readonly record: WorkflowRuntimeRecord;
  readonly definition: WorkflowDefinition;
}): WorkflowRuntimeRecord {
  let current = input.record;
  for (;;) {
    const candidate = input.definition.transitions.find(
      (transition) =>
        transition.kind === "automatic" &&
        transition.from === current.state &&
        transitionMatchesDifficulty(current.difficulty, transition.difficulty) &&
        conditionSatisfied(transition.condition, conditionContext(current)),
    );
    if (candidate?.kind !== "automatic") return current;
    const executionId = `wfauto_${randomUUID()}`;
    current = mutateWorkflowRecord(
      input.cwd,
      current.instanceId,
      current.actorId,
      current.revision,
      (latest) => {
        if (
          latest.state !== candidate.from ||
          !conditionSatisfied(candidate.condition, conditionContext(latest))
        ) {
          return latest;
        }
        latest.state = candidate.to;
        latest.completed = [
          ...latest.completed,
          {
            executionId,
            transitionId: candidate.id,
            handleId: `auto_${executionId}`,
            completedAt: now(),
            accepted: true,
          },
        ];
        latest.revision += 1;
        return latest;
      },
    );
  }
}

export function finalizeHandleWorkflow(input: {
  readonly cwd: string;
  readonly handle: WorkflowHandleRecord;
}): WorkflowRuntimeRecord | undefined {
  const binding = input.handle.workflowBinding;
  if (!binding || input.handle.status === "starting" || input.handle.status === "running") {
    return undefined;
  }
  let record = readWorkflowRecord(input.cwd, binding.instanceId, binding.actorId);
  if (!record) {
    throw new Error(
      `Workflow record not found while finalizing handle ${input.handle.id}: ` +
        `${binding.instanceId}/${binding.actorId}`,
    );
  }
  const definition = requireWorkflowDefinition(record.definitionId);
  if (
    record.completed.some((completed) => completed.executionId === binding.transitionExecutionId)
  ) {
    return applyAutomaticTransitions({
      cwd: input.cwd,
      record,
      definition,
    });
  }
  const transition = definition.transitions.find((item) => item.id === binding.transitionId);
  if (transition?.kind !== "delegate") {
    throw new Error(`Unknown delegate transition ${binding.transitionId}`);
  }
  if (
    transition.onAccepted !== binding.acceptedState ||
    transition.onRejected !== binding.rejectedState
  ) {
    throw new Error(`Workflow binding does not match transition ${binding.transitionId}`);
  }
  if (input.handle.status === "completed") {
    record = acceptTransition(input.cwd, record, {
      executionId: binding.transitionExecutionId,
      nextState: binding.acceptedState,
      newFacts: factsFromTransitionResult(transition, input.handle.value),
    });
  } else {
    record = rejectTransition(input.cwd, record, {
      executionId: binding.transitionExecutionId,
      nextState: binding.rejectedState,
    });
  }
  return applyAutomaticTransitions({
    cwd: input.cwd,
    record,
    definition,
  });
}
