import type {
  CapabilitySet,
  ContextPolicy,
  DefinitionRef,
  ToolPolicy,
} from "../definition/definition.ts";
import type { ModelSelector, ResolvedModel } from "../definition/model.ts";
import type { DefinitionId, Outcome, RunId } from "../shared.ts";

export type RunKind = "root" | "agent" | "workflow";

export type RunState =
  | "created"
  | "starting"
  | "running"
  | "waiting"
  | "completing"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

export interface RunLimits {
  readonly timeoutMs: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepairAttempts?: number;
  readonly maxNodeRuns?: number;
  readonly maxParallelism?: number;
}

export interface WorkflowCausation {
  readonly workflowRunId: RunId;
  readonly nodeId: string;
  readonly activationId: string;
}

export interface CompiledRunSpec {
  readonly definitionId: DefinitionId;
  readonly input: unknown;
  readonly outputSchemaId: string;
  readonly tools: readonly string[];
  readonly contextPolicy?: ContextPolicy;
  readonly modelSelector?: ModelSelector;
  readonly limits: RunLimits;
  readonly capabilities: CapabilitySet;
  readonly invocation: {
    readonly wait: "await" | "background";
    readonly causation?: WorkflowCausation;
  };
}

export interface RunRecord {
  readonly id: RunId;
  readonly parentId?: RunId;
  readonly kind: RunKind;
  readonly definitionId: DefinitionId;
  readonly input: unknown;
  readonly outputSchemaId: string;
  readonly requestedAt: string;
  readonly ownership: "attached" | "detached";
  readonly state: RunState;
  readonly revision: number;
  readonly compiled: CompiledRunSpec;
  readonly pi?: {
    readonly sessionId: string;
    readonly sessionFile?: string;
  };
  readonly resolvedModel?: ResolvedModel;
  readonly outcome?: Outcome<unknown>;
}

export interface RunSnapshot extends RunRecord {
  readonly activeChildren: readonly RunId[];
}

export interface StartRun<I, O> {
  readonly parentId: RunId;
  readonly definition: DefinitionRef<I, O>;
  readonly input: I;
  readonly wait: "await" | "background";
  readonly lifetime?: "attached" | "detached-to-root";
}

export interface RootRunInput {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
}

export const ROOT_DEFINITION_ID = "root.session" as DefinitionId;

export const ROOT_CAPABILITIES: CapabilitySet = Object.freeze({
  invokableDefinitions: [],
  maxDepth: 8,
  mayDetach: true,
  maySend: true,
  mayCancelChildren: true,
});

export const ROOT_TOOL_POLICY: ToolPolicy = Object.freeze({ allow: [] });
