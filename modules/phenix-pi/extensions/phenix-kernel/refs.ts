/**
 * phenix-kernel — typed symbolic references
 *
 * References are passive values. They must not capture a registry
 * or resolve themselves.
 */

import type {
  AgentClientId,
  AgentKindId,
  CapabilityId,
  ContractDefinitionId,
  ModelSetId,
  WorkflowDefinitionId,
} from "./ids.ts";

// ── Resource kinds ──────────────────────────────────────────────────────────

export type ResourceKind =
  | "agent-client"
  | "contract-definition"
  | "workflow"
  | "model-set"
  | "capability"
  | "agent-kind";

// ── Generic resource reference ──────────────────────────────────────────────

export interface ResourceRef<
  Kind extends ResourceKind,
  Id extends string,
> {
  readonly kind: Kind;
  readonly id: Id;
}

// ── Concrete ref types ──────────────────────────────────────────────────────

export type AgentClientRef = ResourceRef<"agent-client", AgentClientId>;
export type AgentKindRef = ResourceRef<"agent-kind", AgentKindId>;
export type ContractDefinitionRef = ResourceRef<
  "contract-definition",
  ContractDefinitionId
>;
export type WorkflowRef = ResourceRef<"workflow", WorkflowDefinitionId>;
export type ModelSetRef = ResourceRef<"model-set", ModelSetId>;
export type CapabilityRef = ResourceRef<"capability", CapabilityId>;

// ── Reference constructors ──────────────────────────────────────────────────

function ref<
  Kind extends ResourceKind,
  Id extends string,
>(kind: Kind, id: Id): ResourceRef<Kind, Id> {
  return { kind, id };
}

export function agentClientRef(
  id: string | AgentClientId,
): AgentClientRef {
  return ref("agent-client", id as AgentClientId);
}

export function agentKindRef(
  id: string | AgentKindId,
): AgentKindRef {
  return ref("agent-kind", id as AgentKindId);
}

export function contractRef(
  id: string | ContractDefinitionId,
): ContractDefinitionRef {
  return ref("contract-definition", id as ContractDefinitionId);
}

export function workflowRef(
  id: string | WorkflowDefinitionId,
): WorkflowRef {
  return ref("workflow", id as WorkflowDefinitionId);
}

export function modelSetRef(
  id: string | ModelSetId,
): ModelSetRef {
  return ref("model-set", id as ModelSetId);
}

export function capabilityRef(
  id: string | CapabilityId,
): CapabilityRef {
  return ref("capability", id as CapabilityId);
}

// ── Equality helpers ────────────────────────────────────────────────────────

export function refEquals<Kind extends ResourceKind, Id extends string>(
  a: ResourceRef<Kind, Id>,
  b: ResourceRef<Kind, Id>,
): boolean {
  return a.kind === b.kind && a.id === b.id;
}
