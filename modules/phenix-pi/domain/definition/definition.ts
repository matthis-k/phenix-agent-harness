import type { DefinitionId } from "../shared.ts";
import type { ModelSelector, ThinkingPolicy } from "./model.ts";
import type { Schema } from "./schema.ts";

export interface DefinitionRef<I = unknown, O = unknown> {
  readonly id: DefinitionId;
  readonly __input?: I;
  readonly __output?: O;
}

export function definitionRef<I = unknown, O = unknown>(id: DefinitionId): DefinitionRef<I, O> {
  return { id };
}

export interface Definition<I, O> {
  readonly id: DefinitionId;
  readonly kind: "agent" | "workflow";
  readonly input: Schema<I>;
  readonly output: Schema<O>;
  readonly title: string;
  readonly description: string;
}

export interface ToolPolicy {
  readonly allow: readonly string[];
}

export interface ContextPolicy {
  readonly projectFiles: "inherit" | "none" | "selected";
  readonly parentConversation: "none" | "summary" | "selected-messages";
  readonly artifacts: readonly string[];
  readonly maxBytes: number;
}

export interface CapabilitySet {
  readonly invokableDefinitions: readonly DefinitionId[];
  readonly maxDepth: number;
  readonly mayDetach: boolean;
  readonly maySend: boolean;
  readonly mayCancelChildren: boolean;
}

export interface AgentLimits {
  readonly timeoutMs: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepairAttempts: number;
}

export interface PromptTemplate<I> {
  render(input: I): string;
}

export interface AgentDefinition<I, O> extends Definition<I, O> {
  readonly kind: "agent";
  readonly model: ModelSelector;
  readonly thinking: ThinkingPolicy;
  readonly prompt: PromptTemplate<I>;
  readonly tools: ToolPolicy;
  readonly context: ContextPolicy;
  readonly childCapabilities: CapabilitySet;
  readonly limits: AgentLimits;
  readonly persistence: "memory" | "file";
}

export type ValueMappingRef = string;
export type PureDecisionRef = string;
export type PureConditionRef = string;
export type LocalOperationRef = string;

export interface InvokeNode {
  readonly kind: "invoke";
  readonly id: string;
  readonly title?: string;
  readonly definition: DefinitionRef<unknown, unknown>;
  readonly input: ValueMappingRef;
  readonly wait: "await" | "background";
  readonly capabilityOverride?: Partial<CapabilitySet>;
}

export interface LocalNode {
  readonly kind: "local";
  readonly id: string;
  readonly title?: string;
  readonly operation: LocalOperationRef;
  readonly input: ValueMappingRef;
}

export interface DecisionNode {
  readonly kind: "decision";
  readonly id: string;
  readonly title?: string;
  readonly decide: PureDecisionRef;
}

export interface JoinNode {
  readonly kind: "join";
  readonly id: string;
  readonly title?: string;
  readonly policy: "all" | "all-success" | "first-success" | "quorum";
  readonly quorum?: number;
}

export interface ReturnNode {
  readonly kind: "return";
  readonly id: string;
  readonly title?: string;
  readonly output: ValueMappingRef;
}

export interface FailNode {
  readonly kind: "fail";
  readonly id: string;
  readonly title?: string;
  readonly reason: ValueMappingRef;
}

export type WorkflowNode = InvokeNode | LocalNode | DecisionNode | JoinNode | ReturnNode | FailNode;

export interface WorkflowEdge {
  readonly from: string;
  readonly to: string;
  readonly when?: PureConditionRef;
  readonly maxTraversals?: number;
}

export interface WorkflowGraph<I = unknown, O = unknown> {
  readonly entry: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly __input?: I;
  readonly __output?: O;
}

export interface WorkflowDefinition<I, O> extends Definition<I, O> {
  readonly kind: "workflow";
  readonly graph: WorkflowGraph<I, O>;
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxNodeRuns: number;
    readonly maxParallelism: number;
  };
}

export type AnyDefinition =
  | AgentDefinition<unknown, unknown>
  | WorkflowDefinition<unknown, unknown>;

export function isAgentDefinition(
  definition: AnyDefinition,
): definition is AgentDefinition<unknown, unknown> {
  return definition.kind === "agent";
}

export function isWorkflowDefinition(
  definition: AnyDefinition,
): definition is WorkflowDefinition<unknown, unknown> {
  return definition.kind === "workflow";
}
