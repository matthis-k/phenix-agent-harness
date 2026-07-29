import type { RunId } from "../domain/shared.ts";
import type { AgentSessionReference } from "./agent-session-backend.ts";

export interface LiveAgentTranscriptSnapshot extends AgentSessionReference {
  readonly runId: RunId;
  readonly completeHistory: boolean;
  readonly messages: readonly unknown[];
}

export interface LiveAgentTranscriptReader {
  get(runId: RunId): LiveAgentTranscriptSnapshot | undefined;
  subscribe(listener: (runId: RunId) => void): () => void;
}

export interface LiveAgentTranscriptWriter {
  open(runId: RunId, reference: AgentSessionReference, completeHistory: boolean): void;
  replace(runId: RunId, messages: readonly unknown[]): void;
}
