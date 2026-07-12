/**
 * Workflow Runtime Service
 *
 * The single authoritative production path for assembling the workflow
 * decision context. Every consumer — prompt projection, delegate execution,
 * child contract creation, and workflow state transitions — must use
 * buildWorkflowRuntimeDependencies() to obtain its context.
 *
 * No other module should independently reconstruct workflow definition,
 * record, capabilities, authority, depth, or active handles.
 */

import { randomUUID } from "node:crypto";

import type {
  AgentCapabilityArtifact,
} from "./agent-capabilities.ts";

import type {
  DelegationAuthority,
  WorkflowDefinition,
  WorkflowRuntimeRecord,
} from "./workflow-types.ts";

import type {
  HandleRecord,
} from "../phenix-subagents/handle-types.ts";

import type {
  ContractArtifact,
} from "../phenix-subagents/contract.ts";

import {
  PHENIX_DEFAULT_WORKFLOW,
} from "./workflow-definitions.ts";

import {
  readWorkflowRecord,
  acceptTransition,
  rejectTransition,
} from "./workflow-store.ts";

import {
  requireSessionCapabilityArtifact,
  requireSessionWorkflowData,
} from "./session-registry.ts";

import {
  listRecords,
} from "../phenix-subagents/handle-store.ts";

// ── Dependencies type ───────────────────────────────────────────────────────

export interface WorkflowRuntimeDependencies {
  readonly definition: WorkflowDefinition;

  readonly record: WorkflowRuntimeRecord;

  readonly capabilities: AgentCapabilityArtifact;

  readonly authority: DelegationAuthority;

  readonly activeHandles: readonly HandleRecord[];
}

// ── Actor source ────────────────────────────────────────────────────────────

export type WorkflowActorSource =
  | {
      readonly kind: "root";
      readonly sessionId: string;
    }
  | {
      readonly kind: "child";
      readonly contract: ContractArtifact;
    };

// ── Root constants ──────────────────────────────────────────────────────────

const ROOT_MAXIMUM_DELEGATION_DEPTH = 4;

// ── Main assembly function ──────────────────────────────────────────────────

/**
 * Build the complete runtime dependency set for a workflow actor.
 *
 * This is the ONLY production path that assembles:
 *   - workflow definition
 *   - workflow record
 *   - capability artifact
 *   - role authority
 *   - transition authority
 *   - remaining depth
 *   - active handles
 *
 * Root: derives from the session registry and on-disk workflow record.
 * Child: derives from the active contract and on-disk child actor record.
 */
export function buildWorkflowRuntimeDependencies(
  input: {
    readonly cwd: string;
    readonly sessionId: string;
    readonly source: WorkflowActorSource;
  },
): WorkflowRuntimeDependencies {
  if (input.source.kind === "root") {
    return buildRootDependencies(input.cwd, input.sessionId);
  }
  return buildChildDependencies(input.cwd, input.sessionId, input.source.contract);
}

// ── Root dependency assembly ────────────────────────────────────────────────

function buildRootDependencies(
  cwd: string,
  sessionId: string,
): WorkflowRuntimeDependencies {
  // 1. Get workflow data from session registry.
  const workflowData = requireSessionWorkflowData(sessionId);

  // 2. Get capability artifact from session registry.
  const capabilities = requireSessionCapabilityArtifact(sessionId);

  // 3. Load the root actor workflow record.
  const record = readWorkflowRecord(
    cwd,
    workflowData.instanceId,
    workflowData.actorId,
  );

  if (!record) {
    throw new Error(
      `Root workflow record not found for ` +
      `instance "${workflowData.instanceId}", actor "${workflowData.actorId}". ` +
      `The routing extension must create the root workflow record before ` +
      `delegating or projecting.`,
    );
  }

  // 4. Derive root role authority from the capability artifact.
  //    Root has every spawnable role available, including null (base).
  const availableRoles = capabilities.entries
    .filter((entry) => entry.spawnable)
    .map((entry) => entry.role);

  const authority: DelegationAuthority = {
    roles: {
      presetRevision: 1,
      role: null,
      source: {
        inherited: false,
        patch: {
          additional: [],
          removed: [],
        },
      },
      effective: [...availableRoles],
    },
    availableRoles: [...availableRoles],
    remainingDepth: ROOT_MAXIMUM_DELEGATION_DEPTH,
    transitionAuthority: {
      kind: "unrestricted",
    },
  };

  // 5. Load active handles for the same session and workflow instance.
  const allHandles = listRecords(cwd, sessionId);
  const activeHandles = allHandles.filter(
    (h) =>
      h.workflowBinding?.instanceId === workflowData.instanceId &&
      h.status === "running",
  );

  return {
    definition: PHENIX_DEFAULT_WORKFLOW,
    record,
    capabilities,
    authority,
    activeHandles,
  };
}

// ── Child dependency assembly ───────────────────────────────────────────────

function buildChildDependencies(
  cwd: string,
  sessionId: string,
  contract: ContractArtifact,
): WorkflowRuntimeDependencies {
  // 1. Obtain workflow metadata from the active contract.
  const wfMeta = contract.runtime.workflow;

  // 2. Load the child actor workflow record.
  const record = readWorkflowRecord(
    cwd,
    wfMeta.instanceId,
    wfMeta.actorId,
  );

  if (!record) {
    throw new Error(
      `Child workflow record not found for ` +
      `instance "${wfMeta.instanceId}", actor "${wfMeta.actorId}". ` +
      `The parent must create the child actor record before spawning.`,
    );
  }

  // 3. Verify and load the capability artifact.
  //    For child paths, load from the persisted diagnostic location.
  const capabilities = requireSessionCapabilityArtifact(sessionId);

  // Verify the artifact hash matches what the contract expects.
  if (capabilities.artifactHash !== wfMeta.capabilityArtifactHash) {
    throw new Error(
      `Capability artifact hash mismatch. ` +
      `Contract expects "${wfMeta.capabilityArtifactHash}", ` +
      `session has "${capabilities.artifactHash}". ` +
      `The capability artifact may have changed since the contract was issued.`,
    );
  }

  // 4. Derive authority from the contract's delegation configuration.
  const authority: DelegationAuthority = {
    roles: {
      presetRevision: contract.runtime.delegation.roles.presetRevision,
      role: contract.runtime.delegation.roles.role,
      source: {
        inherited: contract.runtime.delegation.roles.source.inherited,
        patch: {
          additional: [
            ...contract.runtime.delegation.roles.source.patch.additional,
          ],
          removed: [
            ...contract.runtime.delegation.roles.source.patch.removed,
          ],
        },
      },
      effective: [...contract.runtime.delegation.roles.effective],
    },
    availableRoles: [...contract.runtime.delegation.availableRoles],
    remainingDepth: contract.runtime.delegation.remainingDepth,
    transitionAuthority: contract.runtime.workflow.transitionAuthority.kind ===
      "unrestricted"
      ? { kind: "restricted" as const, allowed: [] }
      : {
          kind: "restricted" as const,
          allowed: [...contract.runtime.workflow.transitionAuthority.allowed],
        },
  };

  // 5. Load active handles belonging to this actor.
  const allHandles = listRecords(cwd, sessionId);
  const activeHandles = allHandles.filter(
    (h) =>
      h.workflowBinding?.instanceId === wfMeta.instanceId &&
      h.workflowBinding?.actorId === wfMeta.actorId &&
      h.status === "running",
  );

  return {
    definition: PHENIX_DEFAULT_WORKFLOW,
    record,
    capabilities,
    authority,
    activeHandles,
  };
}

// ── Role-specific initial states ────────────────────────────────────────────

import type { AgentRole } from "../phenix-subagents/agent-types.ts";
import type { WorkflowStateId, WorkflowTransitionId } from "./workflow-types.ts";
import { mkTransitionId } from "./workflow-types.ts";

/**
 * Return the initial workflow state for a given role's actor record.
 */
export function initialWorkflowStateForRole(
  role: AgentRole,
): WorkflowStateId {
  switch (role) {
    case null:
      return "classified";
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
  }
}

// ── Transition authority for child contracts ────────────────────────────────

import type { TransitionAuthority } from "./transition-authority.ts";

/**
 * Resolve the restricted transition authority for a child contract.
 *
 * Collects only delegate transitions that:
 *   - have scope "child" or "both";
 *   - include the child actor role;
 *   - can originate from the child's initial state or known same-role state;
 *   - target a role present in authorizedRoles.
 *
 * Internal critic contracts receive an empty restricted authority.
 */
export function transitionAuthorityForChild(input: {
  readonly definition: WorkflowDefinition;
  readonly role: AgentRole;
  readonly initialState: WorkflowStateId;
  readonly authorizedRoles: readonly AgentRole[];
}): TransitionAuthority {
  const { definition, role, initialState, authorizedRoles } = input;

  const authorizedSet = new Set(authorizedRoles);
  const resolvedIds: WorkflowTransitionId[] = [];

  // Map role to its actor kind for matching.
  const actorKind = role === null ? "base" : role;

  for (const transition of definition.transitions) {
    if (transition.kind !== "delegate") continue;

    // Only "child" or "both" scope.
    if (transition.scope === "root") continue;

    // Must include the child actor role.
    const roleMatches = transition.actorRoles.includes(
      actorKind as "coordinator" | "planner" | "architect" | "implementer" |
        "tester" | "critic" | "finalizer" | "scout",
    );
    if (!roleMatches) continue;

    // Must be able to originate from the child's initial state or known
    // same-role state.
    const sameRoleStates = getStatesForActorRole(actorKind);
    const canOriginate = transition.from.some(
      (s) => s === initialState || sameRoleStates.has(s),
    );
    if (!canOriginate) continue;

    // Target role must be in the authorized set.
    if (!authorizedSet.has(transition.role)) continue;

    resolvedIds.push(mkTransitionId(transition.id));
  }

  return {
    kind: "restricted",
    allowed: resolvedIds,
  };
}

/**
 * Get all workflow states associated with a given actor role.
 */
function getStatesForActorRole(
  actorKind: string,
): Set<WorkflowStateId> {
  const stateMap: Record<string, WorkflowStateId[]> = {
    coordinator: ["classified", "plan-ready", "design-ready", "implementation-ready", "tests-ready", "final-review-ready", "completed", "failed"],
    planner: ["planning"],
    architect: ["designing"],
    implementer: ["implementing"],
    tester: ["testing"],
    critic: ["reviewing"],
    finalizer: ["finalizing"],
    scout: ["scouting"],
    base: ["executing"],
  };

  return new Set(stateMap[actorKind] ?? []);
}

// ── Automatic transition application ────────────────────────────────────────

import { conditionSatisfied } from "./workflow-conditions.ts";
import { transitionMatchesDifficulty } from "./workflow-reducer.ts";
import {
  writeWorkflowRecord,
  acquireWorkflowLock,
  releaseWorkflowLock,
  now,
  readWorkflowRecord as readWf,
} from "./workflow-store.ts";

/**
 * Apply eligible automatic transitions deterministically until stable.
 *
 * Each automatic transition is persisted under the workflow lock with
 * revision increment. The loop terminates when no automatic transition
 * matches the current state.
 */
export function applyAutomaticTransitions(
  input: {
    readonly cwd: string;
    readonly record: WorkflowRuntimeRecord;
    readonly definition: WorkflowDefinition;
  },
): WorkflowRuntimeRecord {
  let current = structuredClone(input.record);

  const completedIds = new Set(current.completed.map((c) => c.transitionId));
  const activeIds = new Set(current.active.map((a) => a.transitionId));

  for (;;) {
    const candidate = input.definition.transitions.find(
      (transition) =>
        transition.kind === "automatic" &&
        transition.from === current.state &&
        transitionMatchesDifficulty(current.difficulty, transition.difficulty) &&
        conditionSatisfied(transition.condition, {
          difficulty: current.difficulty,
          profile: current.taskProfile,
          facts: current.facts,
          completedTransitionIds: completedIds,
          activeTransitionIds: activeIds,
        }),
    );

    if (!candidate) {
      return current;
    }

    // Create a synthetic execution for the automatic transition.
    const executionId = `wfauto_${randomUUID()}`;

    const lock = acquireWorkflowLock(
      input.cwd,
      current.instanceId,
      current.actorId,
    );

    try {
      // Reload to ensure we have the latest.
      const reloaded = readWf(
        input.cwd,
        current.instanceId,
        current.actorId,
      );

      if (!reloaded) return current;

      // Apply the automatic transition.
      if (candidate.kind === "automatic") {
        reloaded.state = candidate.to;

        reloaded.completed = [
          ...reloaded.completed,
          {
            executionId,
            transitionId: candidate.id,
            handleId: `auto_${executionId}`,
            completedAt: now(),
            accepted: true,
          },
        ];
      }

      reloaded.revision += 1;
      reloaded.updatedAt = now();

      writeWorkflowRecord(input.cwd, reloaded);

      completedIds.add(candidate.id);

      current = reloaded;
    } finally {
      releaseWorkflowLock(lock);
    }
  }
}

// ── Handle finalization ────────────────────────────────────────────────────

/**
 * Finalize a handle's workflow state based on the child completion result.
 *
 * Reads the current record, checks whether this execution has already been
 * finalized (idempotent), and dispatches to acceptTransition or
 * rejectTransition with the appropriate target state.
 *
 * Both foreground (await) and background (async) paths should call this
 * after the child run attempt completes.
 */
export function finalizeHandleWorkflow(
  cwd: string,
  instanceId: string,
  actorId: string,
  executionId: string,
  status: "completed" | "failed" | "cancelled",
  acceptedState: import("./workflow-types.ts").WorkflowStateId,
  rejectedState: import("./workflow-types.ts").WorkflowStateId,
): void {
  const record = readWorkflowRecord(cwd, instanceId, actorId);
  if (!record) return;

  // Idempotent: skip if already finalized.
  if (record.completed.some((c) => c.executionId === executionId)) return;

  if (status === "completed") {
    acceptTransition(cwd, record, {
      executionId,
      nextState: acceptedState,
    });
  } else {
    rejectTransition(cwd, record, {
      executionId,
      nextState: rejectedState,
    });
  }
}


