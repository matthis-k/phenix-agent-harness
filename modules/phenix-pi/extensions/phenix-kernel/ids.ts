/**
 * phenix-kernel — branded identifiers
 *
 * Open branded strings for user-registerable resources.
 * These are shared vocabulary only — no Pi imports or runtime logic.
 */

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & {
  readonly [brand]: Name;
};

// ── Agent identifiers ───────────────────────────────────────────────────────

export type AgentKindId = Brand<string, "AgentKindId">;

export type AgentClientId = Brand<string, "AgentClientId">;

// ── Contract identifiers ────────────────────────────────────────────────────

export type ContractDefinitionId = Brand<string, "ContractDefinitionId">;

export type ContractInstanceId = Brand<string, "ContractInstanceId">;

// ── Workflow identifiers ────────────────────────────────────────────────────

export type WorkflowDefinitionId = Brand<string, "WorkflowDefinitionId">;

export type WorkflowStateId = Brand<string, "WorkflowStateId">;

export type WorkflowTransitionId = Brand<string, "WorkflowTransitionId">;

export type WorkflowInstanceId = Brand<string, "WorkflowInstanceId">;

export type WorkflowActorId = Brand<string, "WorkflowActorId">;

// ── Model identifiers ──────────────────────────────────────────────────────

export type ModelSetId = Brand<string, "ModelSetId">;

export type CapabilityId = Brand<string, "CapabilityId">;

// ── Execution identifiers ───────────────────────────────────────────────────

export type RunId = Brand<string, "RunId">;

// ── Constructors (validate non-empty) ───────────────────────────────────────

function brandValue<T extends Brand<string, string>>(
  value: string,
  prefix: string,
): T {
  if (!value || value.trim().length === 0) {
    throw new Error(`${prefix} ID must be non-empty`);
  }
  return value as T;
}

export function agentKindId(value: string): AgentKindId {
  return brandValue(value, "AgentKind");
}

export function agentClientId(value: string): AgentClientId {
  return brandValue(value, "AgentClient");
}

export function contractDefinitionId(value: string): ContractDefinitionId {
  return brandValue(value, "ContractDefinition");
}

export function contractInstanceId(value: string): ContractInstanceId {
  return brandValue(value, "ContractInstance");
}

export function workflowDefinitionId(value: string): WorkflowDefinitionId {
  return brandValue(value, "WorkflowDefinition");
}

export function workflowStateId(value: string): WorkflowStateId {
  return brandValue(value, "WorkflowState");
}

export function workflowTransitionId(value: string): WorkflowTransitionId {
  return brandValue(value, "WorkflowTransition");
}

export function workflowInstanceId(value: string): WorkflowInstanceId {
  return brandValue(value, "WorkflowInstance");
}

export function workflowActorId(value: string): WorkflowActorId {
  return brandValue(value, "WorkflowActor");
}

export function modelSetId(value: string): ModelSetId {
  return brandValue(value, "ModelSet");
}

export function capabilityId(value: string): CapabilityId {
  return brandValue(value, "Capability");
}

export function runId(value: string): RunId {
  return brandValue(value, "Run");
}
