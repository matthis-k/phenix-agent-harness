/**
 * phenix-kernel — typed symbolic references
 *
 * References are passive values. They do not capture a registry or resolve
 * themselves. Every constructor validates its ID through the canonical kernel
 * constructor before creating the reference.
 */

import type {
  AgentClientId,
  AgentKindId,
  CapabilityId,
  ContractDefinitionId,
  ModelSetId,
  WorkflowDefinitionId,
} from "./ids.ts";
import {
  agentClientId,
  agentKindId,
  capabilityId,
  contractDefinitionId,
  modelSetId,
  workflowDefinitionId,
} from "./ids.ts";

export type ResourceKind =
  | "agent-client"
  | "contract-definition"
  | "workflow"
  | "model-set"
  | "capability"
  | "agent-kind";

export interface ResourceRef<Kind extends ResourceKind, Id extends string> {
  readonly kind: Kind;
  readonly id: Id;
}

export type AgentClientRef = ResourceRef<"agent-client", AgentClientId>;
export type AgentKindRef = ResourceRef<"agent-kind", AgentKindId>;
export type ContractDefinitionRef = ResourceRef<"contract-definition", ContractDefinitionId>;
export type WorkflowRef = ResourceRef<"workflow", WorkflowDefinitionId>;
export type ModelSetRef = ResourceRef<"model-set", ModelSetId>;
export type CapabilityRef = ResourceRef<"capability", CapabilityId>;

function ref<Kind extends ResourceKind, Id extends string>(
  kind: Kind,
  id: Id,
): ResourceRef<Kind, Id> {
  return { kind, id };
}

export function agentClientRef(id: string | AgentClientId): AgentClientRef {
  return ref("agent-client", agentClientId(id));
}

export function agentKindRef(id: string | AgentKindId): AgentKindRef {
  return ref("agent-kind", agentKindId(id));
}

export function contractRef(id: string | ContractDefinitionId): ContractDefinitionRef {
  return ref("contract-definition", contractDefinitionId(id));
}

export function workflowRef(id: string | WorkflowDefinitionId): WorkflowRef {
  return ref("workflow", workflowDefinitionId(id));
}

export function modelSetRef(id: string | ModelSetId): ModelSetRef {
  return ref("model-set", modelSetId(id));
}

export function capabilityRef(id: string | CapabilityId): CapabilityRef {
  return ref("capability", capabilityId(id));
}

export function refEquals<Kind extends ResourceKind, Id extends string>(
  left: ResourceRef<Kind, Id>,
  right: ResourceRef<Kind, Id>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}
