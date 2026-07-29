import type { RunId } from "../../domain/shared.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type {
  WorkspaceEffect,
  WorkspaceEvent,
  WorkspaceItemIndex,
  WorkspaceSnapshotEnvelope,
} from "../../domain/workspace/events.ts";
import type { EffectId, WorkspaceState } from "../../domain/workspace/state.ts";
import type {
  ExternalWorkspaceEffect,
  LoadedWorkspaceTranscript,
  WorkspaceEffectRuntime,
} from "../../ports/workspace-effects.ts";
import { reduceWorkspace } from "./reducer.ts";

export interface WorkspaceControllerView<TSnapshot, TTranscript> {
  readonly state: WorkspaceState;
  readonly snapshot?: WorkspaceSnapshotEnvelope<TSnapshot>;
  readonly transcript?: TTranscript;
}

export interface WorkspaceControllerOptions<TSnapshot, TTranscript> {
  readonly state: WorkspaceState;
  readonly runtime: WorkspaceEffectRuntime<TSnapshot, TTranscript>;
  readonly snapshot?: WorkspaceSnapshotEnvelope<TSnapshot>;
  readonly transcript?: LoadedWorkspaceTranscript<TTranscript>;
}

type Listener = () => void;

const EMPTY_ITEM_INDEX: WorkspaceItemIndex = {
  transcript: [],
  editor: [],
  runs: [],
  tasks: [],
  files: [],
  facts: [],
};

export class WorkspaceController<TSnapshot, TTranscript> {
  private readonly runtime: WorkspaceEffectRuntime<TSnapshot, TTranscript>;
  private readonly listeners = new Set<Listener>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly externalAborts = new Set<AbortController>();
  private readonly transcripts = new Map<string, TTranscript>();
  private stateValue: WorkspaceState;
  private snapshotValue: WorkspaceSnapshotEnvelope<TSnapshot> | undefined;
  private snapshotAbort: AbortController | undefined;
  private transcriptAbort: AbortController | undefined;
  private snapshotLoading = false;
  private snapshotDirty = false;
  private disposed = false;
  private requestSequence = 0;

  constructor(options: WorkspaceControllerOptions<TSnapshot, TTranscript>) {
    this.runtime = options.runtime;
    this.stateValue = options.state;
    this.snapshotValue = options.snapshot;
    if (options.transcript?.kind === "ready") {
      this.transcripts.set(options.transcript.handle.key, options.transcript.value);
    }
  }

  get state(): WorkspaceState {
    return this.stateValue;
  }

  get snapshot(): WorkspaceSnapshotEnvelope<TSnapshot> | undefined {
    return this.snapshotValue;
  }

  get currentTranscript(): TTranscript | undefined {
    const availability = this.stateValue.transcript.availability;
    return availability.kind === "ready"
      ? this.transcripts.get(availability.transcript.key)
      : undefined;
  }

  view(): WorkspaceControllerView<TSnapshot, TTranscript> {
    const transcript = this.currentTranscript;
    return {
      state: this.stateValue,
      ...(this.snapshotValue ? { snapshot: this.snapshotValue } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: WorkspaceEvent<TSnapshot>): void {
    if (this.disposed) return;
    const previous = this.stateValue;
    const update = reduceWorkspace(this.stateValue, event);
    this.stateValue = update.state;
    if (this.stateValue !== previous) this.notify();
    for (const effect of update.effects) this.schedule(effect);
  }

  invalidateSnapshot(): void {
    if (this.disposed) return;
    if (this.snapshotLoading) {
      this.snapshotDirty = true;
      return;
    }
    this.dispatch({ type: "snapshot.requested", requestId: this.nextRequestId("snapshot") });
  }

  selectTranscript(runId: RunId): void {
    if (this.disposed) return;
    this.transcriptAbort?.abort();
    this.dispatch({
      type: "transcript.requested",
      requestId: this.nextRequestId("transcript"),
      runId,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.snapshotAbort?.abort();
    this.transcriptAbort?.abort();
    for (const abort of this.externalAborts) abort.abort();
    this.externalAborts.clear();
    this.listeners.clear();
  }

  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private schedule(effect: WorkspaceEffect): void {
    if (effect.type === "diagnostic.record") {
      this.recordDiagnostic(effect.error);
      return;
    }
    if (effect.type === "snapshot.load") {
      if (this.snapshotLoading) {
        this.snapshotDirty = true;
        return;
      }
      this.track(this.loadSnapshot(effect.requestId));
      return;
    }
    if (effect.type === "transcript.load") {
      this.track(this.loadTranscript(effect.requestId, effect.runId));
      return;
    }
    this.track(this.performExternal(effect));
  }

  private async loadSnapshot(requestId: EffectId): Promise<void> {
    this.snapshotLoading = true;
    const abort = new AbortController();
    this.snapshotAbort = abort;
    try {
      const snapshot = await this.runtime.loadSnapshot(abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      const previousItemIds = this.snapshotValue?.itemIds ?? EMPTY_ITEM_INDEX;
      const pending = this.stateValue.pendingEffects.get(requestId);
      const accepted =
        pending?.type === "snapshot.load" && snapshot.revision >= this.stateValue.snapshotRevision;
      if (accepted) this.snapshotValue = snapshot;
      this.dispatch({
        type: "snapshot.received",
        requestId,
        previousItemIds,
        snapshot,
      });
    } catch (error) {
      if (this.disposed || abort.signal.aborted) return;
      this.dispatch({
        type: "snapshot.failed",
        requestId,
        error: effectFailure("snapshot-load-failed", "workspace", error),
      });
    } finally {
      if (this.snapshotAbort === abort) this.snapshotAbort = undefined;
      this.snapshotLoading = false;
      if (!this.disposed && this.snapshotDirty) {
        this.snapshotDirty = false;
        this.invalidateSnapshot();
      }
    }
  }

  private async loadTranscript(requestId: EffectId, runId: RunId): Promise<void> {
    const abort = new AbortController();
    this.transcriptAbort = abort;
    try {
      const loaded = await this.runtime.loadTranscript(runId, abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      if (loaded.kind === "ready") {
        this.transcripts.set(loaded.handle.key, loaded.value);
      }
      const previous = this.stateValue.transcript.availability;
      this.dispatch({
        type: "transcript.loaded",
        requestId,
        runId,
        availability: loaded.kind === "ready" ? { kind: "ready", transcript: loaded.handle } : loaded,
      });
      if (loaded.kind !== "ready") return;
      const current = this.stateValue.transcript.availability;
      if (
        current.kind !== "ready" ||
        current.transcript.key !== loaded.handle.key ||
        previous.kind !== "pending" ||
        previous.requestId !== requestId
      ) {
        this.transcripts.delete(loaded.handle.key);
      }
    } catch (error) {
      if (this.disposed || abort.signal.aborted) return;
      this.dispatch({
        type: "transcript.failed",
        requestId,
        runId,
        error: effectFailure("transcript-load-failed", runId, error),
      });
    } finally {
      if (this.transcriptAbort === abort) this.transcriptAbort = undefined;
    }
  }

  private async performExternal(effect: ExternalWorkspaceEffect): Promise<void> {
    if (!this.runtime.perform || this.disposed) return;
    const abort = new AbortController();
    this.externalAborts.add(abort);
    try {
      await this.runtime.perform(effect, abort.signal);
    } catch (error) {
      if (this.disposed || abort.signal.aborted) return;
      this.recordDiagnostic(effectFailure("invariant-violation", "workspace", error));
    } finally {
      this.externalAborts.delete(abort);
    }
  }

  private recordDiagnostic(error: WorkspaceError): void {
    try {
      void Promise.resolve(this.runtime.recordDiagnostic(error)).catch(() => undefined);
    } catch {
      // Diagnostic persistence is deliberately non-authoritative.
    }
  }

  private track(task: Promise<void>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private nextRequestId(prefix: string): EffectId {
    this.requestSequence += 1;
    return `${prefix}-${this.requestSequence}` as EffectId;
  }
}

function effectFailure(
  code: "snapshot-load-failed" | "transcript-load-failed" | "invariant-violation",
  owner: RunId | "workspace",
  cause: unknown,
): WorkspaceError {
  return {
    code,
    owner: owner === "workspace" ? { kind: "workspace" } : { kind: "run", runId: owner },
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
    recoverable: true,
  };
}
