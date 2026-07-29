import type { RunId } from "../domain/shared.ts";
import type { AgentSessionReference } from "./agent-session-backend.ts";

interface LiveAgentTranscriptBase {
  readonly runId: RunId;
  readonly sessionId: string;
  readonly messages: readonly unknown[];
}

export type LiveAgentTranscriptSnapshot =
  | (LiveAgentTranscriptBase & {
      readonly completeHistory: true;
      readonly sessionFile?: string;
    })
  | (LiveAgentTranscriptBase & {
      readonly completeHistory: false;
      readonly sessionFile: string;
    });

export interface LiveAgentTranscriptReader {
  get(runId: RunId): LiveAgentTranscriptSnapshot | undefined;
  subscribe(listener: (runId: RunId) => void): () => void;
}

export interface LiveAgentTranscriptWriter {
  open(runId: RunId, reference: AgentSessionReference, completeHistory: boolean): void;
  replace(runId: RunId, messages: readonly unknown[]): void;
}
