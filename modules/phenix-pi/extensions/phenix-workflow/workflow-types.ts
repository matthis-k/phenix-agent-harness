import type { AgentKind, AgentRole, TaskProfile } from "../phenix-subagents/agent-types.ts";
import type { Difficulty } from "../phenix-routing/types.ts";

// ── Workflow definition identity ────────────────────────────────────────────

export type WorkflowDefinitionId = "phenix-default";

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

declare const workflowTransitionBrand: unique symbol;

export type WorkflowTransitionId = string & {
  readonly [workflowTransitionBrand]: true;
};

export function mkTransitionId(id: string): WorkflowTransitionId {
  return id as WorkflowTransitionId;
}

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

  readonly from: readonly WorkflowStateId[];

  readonly role: AgentRole;
  readonly purpose: DelegationPurpose;

  readonly category: "required" | "optional" | "repair";

  readonly outputSchemaId: WorkflowOutputSchemaId;

  readonly allowedModes: ReadonlyArray<"await" | "background">;

  /**
   * State after the transition's accepted child handle.
   */
  readonly onAccepted: WorkflowStateId;

  /**
   * State after terminal rejection/failure.
   */
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
  readonly id: WorkflowDefinitionId;
  readonly version: 1;

  readonly initialState: WorkflowStateId;

  readonly transitions: readonly WorkflowTransition[];
}

// ── Output schema identifiers ───────────────────────────────────────────────

export type WorkflowOutputSchemaId =
  | "scout-handoff"
  | "planner-handoff"
  | "architecture-handoff"
  | "implementation-handoff"
  | "test-handoff"
  | "finalizer-handoff"
  | "critic-handoff"
  | "base-handoff";

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

  readonly definitionId: WorkflowDefinitionId;
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

import type { TransitionAuthority } from "./transition-authority.ts";
import type { ResolvedDelegateRoleConfiguration } from "../phenix-subagents/delegation-policy.ts";

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
