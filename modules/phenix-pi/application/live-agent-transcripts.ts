import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { RunId } from "../domain/shared.ts";
import type { AgentSessionReference } from "../ports/agent-session-backend.ts";

export interface LiveAgentTranscriptSnapshot extends AgentSessionReference {
  readonly runId: RunId;
  readonly completeHistory: boolean;
  readonly messages: readonly AgentMessage[];
}

export interface LiveAgentTranscriptReader {
  get(runId: RunId): LiveAgentTranscriptSnapshot | undefined;
  subscribe(listener: (runId: RunId) => void): () => void;
}

export interface LiveAgentTranscriptWriter {
  open(runId: RunId, reference: AgentSessionReference, completeHistory: boolean): void;
  replace(runId: RunId, messages: readonly AgentMessage[]): void;
}

export class LiveAgentTranscriptStore
  implements LiveAgentTranscriptReader, LiveAgentTranscriptWriter
{
  private readonly snapshots = new Map<RunId, LiveAgentTranscriptSnapshot>();
  private readonly listeners = new Set<(runId: RunId) => void>();

  get(runId: RunId): LiveAgentTranscriptSnapshot | undefined {
    return this.snapshots.get(runId);
  }

  subscribe(listener: (runId: RunId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(runId: RunId, reference: AgentSessionReference, completeHistory: boolean): void {
    this.snapshots.set(runId, {
      runId,
      sessionId: reference.sessionId,
      ...(reference.sessionFile ? { sessionFile: reference.sessionFile } : {}),
      completeHistory,
      messages: [],
    });
    this.notify(runId);
  }

  replace(runId: RunId, messages: readonly AgentMessage[]): void {
    const current = this.snapshots.get(runId);
    if (!current) return;
    this.snapshots.set(runId, { ...current, messages: [...messages] });
    this.notify(runId);
  }

  clear(): void {
    this.snapshots.clear();
    this.listeners.clear();
  }

  private notify(runId: RunId): void {
    for (const listener of this.listeners) listener(runId);
  }
}
