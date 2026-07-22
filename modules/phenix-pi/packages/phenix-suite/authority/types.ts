/** Runtime-neutral vocabulary for the single Phenix execution authority. */

export type AssuranceLevel = "A0" | "A1" | "A2" | "A3";

export type ObjectiveState =
  | "active"
  | "paused"
  | "cancelling"
  | "completed"
  | "failed"
  | "discarded";

export type ExecutionNodeState =
  | "pending"
  | "ready"
  | "starting"
  | "running"
  | "submitted"
  | "verifying"
  | "repairable"
  | "accepted"
  | "rejected"
  | "failed"
  | "cancelled"
  | "orphaned";

export type HandleRuntimeState =
  | "created"
  | "starting"
  | "running"
  | "waiting"
  | "settled"
  | "failed"
  | "cancelled"
  | "orphaned";

export type HandleAcceptanceState =
  | "pending"
  | "submitted"
  | "verifying"
  | "accepted"
  | "rejected"
  | "inconclusive"
  | "cancelled";

export type LegalActionKind = "delegate" | "dynamic" | "complete" | "control";
export type ExecutionMode = "await" | "background";

export interface LegalAction {
  readonly id: string;
  readonly kind: LegalActionKind;
  readonly purpose: string;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";
  readonly role?: string;
  readonly outputSchemaId?: string;
  readonly allowedModes: readonly ExecutionMode[];
  readonly remainingExecutions?: number;
  readonly reason: string;
}

export interface ObjectiveRecord {
  readonly id: string;
  readonly rootSessionId: string;
  readonly rootActorId: string;
  readonly userTask: string;
  readonly latestAmendment?: string;
  readonly workflowDefinitionId: string;
  readonly difficulty: string;
  readonly assurance: AssuranceLevel;
  readonly state: ObjectiveState;
  readonly rootNodeId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly failure?: string;
}

export interface ExecutionNodeRecord {
  readonly id: string;
  readonly objectiveId: string;
  readonly parentNodeId?: string;
  readonly taskUid?: string;
  readonly actionId?: string;
  readonly purpose: string;
  readonly assignment: string;
  readonly requirements: readonly string[];
  readonly role?: string;
  readonly outputSchemaId?: string;
  readonly assurance: AssuranceLevel;
  readonly depth: number;
  readonly dependencies: readonly string[];
  readonly state: ExecutionNodeState;
  readonly attempt: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt?: string;
  readonly failure?: string;
}

export interface ExecutionHandleRecord {
  readonly id: string;
  readonly objectiveId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly mode: ExecutionMode;
  readonly runtimeState: HandleRuntimeState;
  readonly acceptanceState: HandleAcceptanceState;
  readonly childRunId?: string;
  readonly piSessionId?: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
  readonly verificationEvidence?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly settledAt?: string;
  readonly acceptedAt?: string;
}

export interface DynamicNodeRequest {
  readonly purpose: string;
  readonly assignment: string;
  readonly requirements?: readonly string[];
  readonly role?: string;
  readonly outputSchemaId: string;
  readonly assurance?: AssuranceLevel;
  readonly dependencies?: readonly string[];
  readonly mode?: ExecutionMode;
}

export interface ExecutionAuthoritySnapshot {
  readonly sequence: number;
  readonly objective: ObjectiveRecord;
  readonly nodes: readonly ExecutionNodeRecord[];
  readonly handles: readonly ExecutionHandleRecord[];
  readonly legalActions: readonly LegalAction[];
}

export type ExecutionAuthorityEventType =
  | "objective.started"
  | "objective.resumed"
  | "objective.paused"
  | "objective.amended"
  | "objective.discarded"
  | "objective.completed"
  | "objective.failed"
  | "authority.actions.changed"
  | "node.created"
  | "node.updated"
  | "handle.created"
  | "handle.runtime.changed"
  | "result.submitted"
  | "verification.started"
  | "acceptance.decided"
  | "capability.revoked"
  | "recovery.performed";

export interface ExecutionAuthorityEvent {
  readonly id: string;
  readonly objectiveId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly timestamp: string;
  readonly type: ExecutionAuthorityEventType;
  readonly actorId: string;
  readonly nodeId?: string;
  readonly handleId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface AuthorityMutation {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly expectedRevision?: number;
}

export interface BeginObjectiveInput {
  readonly id?: string;
  readonly rootSessionId: string;
  readonly rootActorId: string;
  readonly userTask: string;
  readonly workflowDefinitionId: string;
  readonly difficulty: string;
  readonly assurance: AssuranceLevel;
}

export interface CreateNodeInput {
  readonly objectiveId: string;
  readonly parentNodeId?: string;
  readonly taskUid?: string;
  readonly actionId?: string;
  readonly purpose: string;
  readonly assignment: string;
  readonly requirements?: readonly string[];
  readonly role?: string;
  readonly outputSchemaId?: string;
  readonly assurance?: AssuranceLevel;
  readonly dependencies?: readonly string[];
  readonly attempt?: number;
}

export interface RegisterHandleInput {
  readonly id: string;
  readonly objectiveId: string;
  readonly nodeId: string;
  readonly mode: ExecutionMode;
  readonly attempt?: number;
  readonly childRunId?: string;
  readonly piSessionId?: string;
}

export interface RuntimeHandleUpdate {
  readonly runtimeState: HandleRuntimeState;
  readonly childRunId?: string;
  readonly piSessionId?: string;
  readonly errors?: readonly string[];
}

export interface AcceptanceDecision {
  readonly outcome: "accepted" | "rejected" | "inconclusive";
  readonly value?: unknown;
  readonly errors?: readonly string[];
  readonly verificationEvidence?: unknown;
  readonly repairAllowed?: boolean;
}

export interface ExecutionAuthorityPersistence {
  readonly sequence: number;
  readonly objectives: readonly ObjectiveRecord[];
  readonly nodes: readonly ExecutionNodeRecord[];
  readonly handles: readonly ExecutionHandleRecord[];
  readonly legalActionsByObjective: Readonly<Record<string, readonly LegalAction[]>>;
  readonly events: readonly ExecutionAuthorityEvent[];
  readonly idempotency: Readonly<
    Record<string, { readonly fingerprint: string; readonly value: unknown }>
  >;
}
