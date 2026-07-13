import { type AgentKind, type AgentRole, isAgentKind } from "../phenix-kernel/agents.ts";
import { type WorkflowTransitionId, workflowTransitionId } from "../phenix-kernel/ids.ts";
import type { AgentClientRef, ContractDefinitionRef } from "../phenix-kernel/refs.ts";
import type { Difficulty, TaskProfile } from "../phenix-kernel/task.ts";
import type { TransitionAuthority } from "./transition-authority.ts";

/**
 * Closed identity of the workflow implementation shipped by this package.
 *
 * Kernel `WorkflowDefinitionId` remains the open branded vocabulary used for
 * symbolic references. Runtime records are deliberately narrower while Phenix
 * supports exactly one built-in workflow.
 */
export type DefaultWorkflowDefinitionId = "phenix-default";

export type { WorkflowTransitionId };

/** Construct a validated open workflow-transition identifier. */
export const mkTransitionId = workflowTransitionId;

// ── Workflow states (semantic task progression) ─────────────────────────────

export type WorkflowStateId =
  | "classified"
  | "planning"
  | "plan-ready"
  | "designing"
  | "design-ready"
  | "implementing"
  | "implementation-ready"
  | "testing"
  | "tests-ready"
  | "finalizing"
  | "final-review-ready"
  | "completed"
  | "failed"
  | "cancelled"
  // Child-local states
  | "scouting"
  | "reviewing"
  // Base execution state
  | "executing";

// ── Delegation purposes ─────────────────────────────────────────────────────

export type DelegationPurpose =
  | "discover-repository"
  | "discover-tests"
  | "discover-constraints"
  | "produce-plan"
  | "produce-architecture"
  | "implement"
  | "test"
  | "review-final"
  | "finalize"
  | "nested-evidence"
  | "nested-testing"
  | "nested-review";

// ── Transition conditions ───────────────────────────────────────────────────

export type WorkflowFactKey = string;

export type TransitionCondition =
  | { readonly kind: "always" }
  | {
      readonly kind: "profile-at-least";
      readonly field: keyof TaskProfile;
      readonly value: number;
    }
  | {
      readonly kind: "workflow-fact";
      readonly key: WorkflowFactKey;
      readonly equals: boolean | string | number;
    }
  | {
      readonly kind: "transition-completed";
      readonly transitionId: WorkflowTransitionId;
    }
  | {
      readonly kind: "all";
      readonly conditions: readonly TransitionCondition[];
    }
  | {
      readonly kind: "any";
      readonly conditions: readonly TransitionCondition[];
    }
  | {
      readonly kind: "not";
      readonly condition: TransitionCondition;
    };

// ── Condition evaluation context ────────────────────────────────────────────

export interface WorkflowConditionContext {
  readonly difficulty: Difficulty;
  readonly profile: TaskProfile;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly completedTransitionIds: ReadonlySet<string>;
  readonly activeTransitionIds: ReadonlySet<string>;
}

// ── Transition base ─────────────────────────────────────────────────────────

export interface TransitionBase {
  readonly id: WorkflowTransitionId;
  readonly description: string;
}

// ── Delegate transition (spawns a child) ────────────────────────────────────

export interface DelegateTransition extends TransitionBase {
  readonly kind: "delegate";

  readonly difficulty: readonly Difficulty[];

  readonly scope: "root" | "child" | "both";

  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;

  /** Agent clients authorized to start this transition. */
  readonly actorClients: readonly AgentClientRef[];

  readonly from: readonly WorkflowStateId[];

  /** Agent client that will execute this transition. */
  readonly agentClient: AgentClientRef;

  readonly purpose: DelegationPurpose;

  readonly category: "required" | "optional" | "repair";

  /** Contract definition produced by this transition. */
  readonly outputContract: ContractDefinitionRef;

  readonly allowedModes: ReadonlyArray<"await" | "background">;

  /** State after the transition's accepted child handle. */
  readonly onAccepted: WorkflowStateId;

  /** State after terminal rejection/failure. */
  readonly onRejected: WorkflowStateId;

  /** Optional state-machine conditions. */
  readonly condition?: TransitionCondition;

  /** Optional parallel group for independent root-level fan-out. */
  readonly parallelGroup?: string;

  /** Maximum successful/running executions of this transition per actor. */
  readonly maxExecutions?: number;
}

// ── Automatic transition (no delegation required) ───────────────────────────

export interface AutomaticTransition extends TransitionBase {
  readonly kind: "automatic";

  readonly difficulty: readonly Difficulty[];

  readonly from: WorkflowStateId;
  readonly to: WorkflowStateId;

  readonly condition: TransitionCondition;
}

// ── Workflow transition union ───────────────────────────────────────────────

export type WorkflowTransition = DelegateTransition | AutomaticTransition;

// ── Workflow definition ─────────────────────────────────────────────────────

export interface WorkflowDefinition {
  readonly id: DefaultWorkflowDefinitionId;
  readonly version: 1;

  readonly initialState: WorkflowStateId;

  readonly transitions: readonly WorkflowTransition[];
}

// ── Output schema identifiers ───────────────────────────────────────────────

export const WORKFLOW_OUTPUT_SCHEMA_IDS = [
  "scout-handoff",
  "planner-handoff",
  "architecture-handoff",
  "implementation-handoff",
  "test-handoff",
  "finalizer-handoff",
  "critic-handoff",
  "base-handoff",
] as const;

export type WorkflowOutputSchemaId = (typeof WORKFLOW_OUTPUT_SCHEMA_IDS)[number];

export function isWorkflowOutputSchemaId(value: unknown): value is WorkflowOutputSchemaId {
  return (
    typeof value === "string" && WORKFLOW_OUTPUT_SCHEMA_IDS.some((schemaId) => schemaId === value)
  );
}

/** Convert a linked agent client into the child-runtime role vocabulary. */
export function roleForAgentClient(ref: AgentClientRef): AgentRole {
  if (ref.id === "base") return null;
  if (isAgentKind(ref.id)) return ref.id;

  throw new Error(`Agent client "${ref.id}" cannot be used as a child execution role`);
}

/** Convert a linked agent client into the workflow actor vocabulary. */
export function actorRoleForAgentClient(ref: AgentClientRef): "base" | "coordinator" | AgentKind {
  if (ref.id === "base") return "base";
  if (ref.id === "coordinator") return "coordinator";
  if (isAgentKind(ref.id)) return ref.id;

  throw new Error(`Agent client "${ref.id}" cannot be used as a workflow actor role`);
}

/** Convert a contract reference into the workflow schema registry vocabulary. */
export function outputSchemaIdForContract(ref: ContractDefinitionRef): WorkflowOutputSchemaId {
  if (isWorkflowOutputSchemaId(ref.id)) return ref.id;

  throw new Error(`Contract "${ref.id}" has no workflow output-schema projection`);
}

// ── Runtime workflow record ─────────────────────────────────────────────────

export interface ActiveWorkflowTransition {
  readonly executionId: string;
  readonly transitionId: WorkflowTransitionId;
  readonly handleId: string;
  readonly startedAt: string;
}

export interface CompletedWorkflowTransition {
  readonly executionId: string;
  readonly transitionId: WorkflowTransitionId;
  readonly handleId: string;
  readonly completedAt: string;
  readonly accepted: boolean;
}

export interface WorkflowRuntimeRecord {
  readonly version: 1;

  readonly instanceId: string;
  readonly actorId: string;
  readonly parentActorId?: string;

  readonly sessionId: string;

  readonly definitionId: DefaultWorkflowDefinitionId;
  readonly definitionVersion: 1;

  readonly difficulty: Difficulty;
  readonly taskProfile: TaskProfile;

  readonly actorRole: "coordinator" | AgentKind | "base";

  state: WorkflowStateId;
  revision: number;

  facts: Record<string, unknown>;

  active: ActiveWorkflowTransition[];

  completed: CompletedWorkflowTransition[];

  readonly capabilityArtifactHash: string;

  readonly createdAt: string;
  updatedAt: string;
}

// ── Delegation authority ────────────────────────────────────────────────────

export interface DelegateRolePatch {
  readonly additional: readonly AgentRole[];
  readonly removed: readonly AgentRole[];
}

export interface ResolvedDelegateRoleConfiguration {
  readonly presetRevision: 1;
  readonly role: AgentRole;
  readonly source: {
    readonly inherited: boolean;
    readonly patch: DelegateRolePatch;
  };
  readonly effective: readonly AgentRole[];
}

export interface WorkflowBinding {
  readonly instanceId: string;
  readonly actorId: string;
  readonly transitionExecutionId: string;
  readonly transitionId: WorkflowTransitionId;
  readonly sourceState: WorkflowStateId;
  readonly sourceRevision: number;
  readonly acceptedState: WorkflowStateId;
  readonly rejectedState: WorkflowStateId;
}

export interface WorkflowHandleRecord {
  readonly id: string;
  readonly sessionId: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "orphaned";
  readonly workflowBinding?: WorkflowBinding;
  readonly value?: unknown;
}

export interface WorkflowContractArtifact {
  readonly identity: {
    readonly role: AgentRole;
  };
  readonly runtime: {
    readonly delegation: {
      readonly roles: ResolvedDelegateRoleConfiguration;
      readonly availableRoles: readonly AgentRole[];
      readonly remainingDepth: number;
    };
    readonly workflow: {
      readonly instanceId: string;
      readonly actorId: string;
      readonly parentActorId?: string;
      readonly definitionId: DefaultWorkflowDefinitionId;
      readonly definitionVersion: 1;
      readonly difficulty: Difficulty;
      readonly initialState: WorkflowStateId;
      readonly transitionAuthority: TransitionAuthority;
      readonly capabilityArtifactHash: string;
    };
  };
}

export interface WorkflowHandleStorePort {
  listRecords(cwd: string, sessionId: string): readonly WorkflowHandleRecord[];
}

export interface DelegationAuthority {
  readonly roles: ResolvedDelegateRoleConfiguration;

  readonly availableRoles: readonly AgentRole[];

  readonly remainingDepth: number;

  readonly transitionAuthority: TransitionAuthority;
}

// ── Resolved delegation option ──────────────────────────────────────────────

export interface DelegationOption {
  readonly transitionId: WorkflowTransitionId;

  readonly workflowRevision: number;

  readonly role: AgentRole;
  readonly targetState: WorkflowStateId;

  readonly purpose: DelegationPurpose;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";

  readonly outputSchemaId: WorkflowOutputSchemaId;
  readonly outputSchema: Record<string, unknown>;

  readonly allowedModes: ReadonlyArray<"await" | "background">;
}
