import type { ContextPolicy } from "../domain/definition/definition.ts";
import type { ConcreteModelRef, PiThinkingLevel } from "../domain/definition/model.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { RunId } from "../domain/shared.ts";

export interface AgentToolResult {
  readonly text: string;
  readonly details?: unknown;
  readonly terminate?: boolean;
}

export interface AgentTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Schema<unknown>;
  execute(input: unknown, signal?: AbortSignal): Promise<AgentToolResult>;
}

export type AgentBackendFailure =
  | {
      readonly kind: "provider_error";
      readonly stopReason: "error";
      readonly message: string;
      readonly retryable: true;
      readonly providerMessage: string | null;
    }
  | {
      readonly kind: "unexpected_abort";
      readonly stopReason: "aborted";
      readonly message: string;
      readonly retryable: true;
    };

export type AgentSessionBackendFailureObservation = Readonly<
  { readonly type: "backend.failed" } & AgentBackendFailure
>;

export type AgentSessionObservation =
  | { readonly type: "cycle.settled" }
  | { readonly type: "turn.ended" }
  | {
      readonly type: "tool.started";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly input?: unknown;
    }
  | {
      readonly type: "tool.finished";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly isError: boolean;
    }
  | AgentSessionBackendFailureObservation;

export interface AgentSessionReference {
  readonly sessionId: string;
  readonly sessionFile?: string;
}

export interface AgentSessionPort {
  readonly reference: AgentSessionReference;
  readonly isStreaming: boolean;
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  notify(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  subscribe(listener: (event: AgentSessionObservation) => void): () => void;
}

export interface CreateAgentSessionSpec {
  readonly runId: RunId;
  readonly cwd: string;
  readonly model: ConcreteModelRef;
  readonly thinking: PiThinkingLevel;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly customTools: readonly AgentTool[];
  readonly context: ContextPolicy;
  readonly persistence: "memory" | "file";
}

export interface AgentSessionBackend {
  create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort>;
  recover(
    spec: CreateAgentSessionSpec,
    reference: AgentSessionReference,
  ): Promise<AgentSessionPort | undefined>;
}
