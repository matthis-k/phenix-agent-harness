import type { RunId } from "../../domain/shared.ts";
import type { AgentSessionReference } from "../../ports/agent-session-backend.ts";
import type {
  LiveAgentTranscriptReader,
  LiveAgentTranscriptSnapshot,
  LiveAgentTranscriptWriter,
} from "../../ports/live-agent-transcripts.ts";

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
    this.snapshots.set(runId, parseTranscriptSnapshot(runId, reference, completeHistory));
    this.notify(runId);
  }

  replace(runId: RunId, messages: readonly unknown[]): void {
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

function parseTranscriptSnapshot(
  runId: RunId,
  reference: AgentSessionReference,
  completeHistory: boolean,
): LiveAgentTranscriptSnapshot {
  if (completeHistory) {
    return {
      runId,
      sessionId: reference.sessionId,
      ...(reference.sessionFile ? { sessionFile: reference.sessionFile } : {}),
      completeHistory: true,
      messages: [],
    };
  }

  if (!reference.sessionFile) {
    throw new Error("A partial live transcript requires a durable Pi session file");
  }

  return {
    runId,
    sessionId: reference.sessionId,
    sessionFile: reference.sessionFile,
    completeHistory: false,
    messages: [],
  };
}
