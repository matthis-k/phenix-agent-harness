import type { RunId } from "../../domain/shared.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type { WorkspaceEvent, WorkspaceSnapshotEnvelope } from "../../domain/workspace/events.ts";
import {
  createInitialWorkspaceState,
  type PaneId,
  type WorkspaceState,
} from "../../domain/workspace/state.ts";
import { WORKSPACE_SURFACE_IDS, type WorkspaceSurfaceId } from "../../domain/workspace/surfaces.ts";
import type {
  ExternalWorkspaceEffect,
  LoadedWorkspaceTranscript,
  ReadyWorkspaceTranscript,
  WorkspaceEffectRuntime,
} from "../../ports/workspace-effects.ts";
import { WorkspaceController } from "./controller.ts";

export type WorkspaceSourceChange =
  | { readonly kind: "snapshot" }
  | { readonly kind: "transcript"; readonly runId: RunId };

export type WorkspaceSourceListener = (change?: WorkspaceSourceChange) => void;

export interface WorkspaceFrontendOptions<TSnapshot, TTranscript> {
  readonly initialSnapshot: WorkspaceSnapshotEnvelope<TSnapshot>;
  readonly initialTranscript: ReadyWorkspaceTranscript<TTranscript>;
  readonly loadSnapshot: (signal: AbortSignal) => Promise<WorkspaceSnapshotEnvelope<TSnapshot>>;
  readonly loadTranscript: (
    runId: RunId,
    snapshot: TSnapshot,
    signal: AbortSignal,
  ) => Promise<LoadedWorkspaceTranscript<TTranscript>>;
  readonly subscribeSource: (listener: WorkspaceSourceListener) => () => void;
  readonly recordDiagnostic?: (error: WorkspaceError) => void | Promise<void>;
  readonly perform?: (effect: ExternalWorkspaceEffect, signal: AbortSignal) => void | Promise<void>;
}

export interface WorkspaceFrontendChange {
  readonly revision: number;
  readonly dirtySurfaces: ReadonlySet<WorkspaceSurfaceId>;
  readonly layoutChanged: boolean;
}

export interface WorkspaceFrontendView<TSnapshot, TTranscript> {
  readonly state: WorkspaceState;
  readonly snapshot: TSnapshot;
  readonly transcript?: TTranscript;
}

type WorkspaceFrontendListener = (change: WorkspaceFrontendChange) => void;

interface WorkspaceFrontendObservation<TSnapshot, TTranscript> {
  readonly state: WorkspaceState;
  readonly snapshot: WorkspaceSnapshotEnvelope<TSnapshot>;
  readonly transcript?: TTranscript;
}

export class WorkspaceFrontend<TSnapshot, TTranscript> {
  private readonly controller: WorkspaceController<TSnapshot, TTranscript>;
  private readonly listeners = new Set<WorkspaceFrontendListener>();
  private readonly unsubscribeController: () => void;
  private readonly unsubscribeSource: () => void;
  private lastSnapshot: WorkspaceSnapshotEnvelope<TSnapshot>;
  private rootTranscript: { readonly runId: RunId; readonly transcript: TTranscript };
  private retainedTranscript:
    | { readonly runId: RunId; readonly transcript: TTranscript }
    | undefined;
  private observation: WorkspaceFrontendObservation<TSnapshot, TTranscript>;
  private changeRevision = 0;
  private suppressRunSurfaceChanges = false;
  private disposed = false;

  constructor(options: WorkspaceFrontendOptions<TSnapshot, TTranscript>) {
    this.lastSnapshot = options.initialSnapshot;
    this.rootTranscript = {
      runId: options.initialSnapshot.rootRunId,
      transcript: options.initialTranscript.value,
    };

    let controller!: WorkspaceController<TSnapshot, TTranscript>;
    const runtime: WorkspaceEffectRuntime<TSnapshot, TTranscript> = {
      loadSnapshot: options.loadSnapshot,
      loadTranscript: async (runId, signal) => {
        const snapshot = controller.snapshot ?? options.initialSnapshot;
        const loaded = await options.loadTranscript(runId, snapshot.value, signal);
        if (loaded.kind === "ready" && runId === snapshot.rootRunId) {
          this.rootTranscript = { runId, transcript: loaded.value };
        }
        return loaded;
      },
      recordDiagnostic: (error) => options.recordDiagnostic?.(error),
      ...(options.perform ? { perform: options.perform } : {}),
    };

    controller = new WorkspaceController({
      state: initialState(options.initialSnapshot, options.initialTranscript),
      runtime,
      snapshot: options.initialSnapshot,
      transcript: options.initialTranscript,
    });
    this.controller = controller;
    this.observation = this.captureObservation();
    this.unsubscribeController = controller.subscribe(() => this.handleControllerChange());
    this.unsubscribeSource = options.subscribeSource((change) => {
      if (change?.kind === "transcript") {
        this.refreshTranscript(change.runId);
        return;
      }
      controller.invalidateSnapshot();
    });
  }

  get state(): WorkspaceState {
    return this.controller.state;
  }

  get snapshot(): TSnapshot {
    return this.controller.snapshot?.value ?? this.lastSnapshot.value;
  }

  get snapshotEnvelope(): WorkspaceSnapshotEnvelope<TSnapshot> {
    return this.controller.snapshot ?? this.lastSnapshot;
  }

  get transcript(): TTranscript | undefined {
    const current = this.controller.currentTranscript;
    if (current !== undefined) {
      this.retainedTranscript = {
        runId: this.controller.state.activeRunId,
        transcript: current,
      };
      return current;
    }
    if (this.retainedTranscript?.runId === this.controller.state.activeRunId) {
      return this.retainedTranscript.transcript;
    }
    if (this.rootTranscript.runId === this.controller.state.activeRunId) {
      return this.rootTranscript.transcript;
    }
    return undefined;
  }

  view(): WorkspaceFrontendView<TSnapshot, TTranscript> {
    const transcript = this.transcript;
    return {
      state: this.state,
      snapshot: this.snapshot,
      ...(transcript !== undefined ? { transcript } : {}),
    };
  }

  subscribe(listener: WorkspaceFrontendListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: WorkspaceEvent<TSnapshot>): void {
    this.controller.dispatch(event);
  }

  invalidateSnapshot(): void {
    this.controller.invalidateSnapshot();
  }

  refreshTranscript(runId: RunId): void {
    if (runId !== this.controller.state.activeRunId) return;
    this.suppressRunSurfaceChanges = true;
    try {
      this.reloadTranscript();
    } finally {
      this.suppressRunSurfaceChanges = false;
    }
  }

  selectTranscript(selectedRunId: RunId, resetViewport = true): void {
    const previousRunId = this.controller.state.activeRunId;
    if (selectedRunId !== previousRunId) this.retainedTranscript = undefined;
    else this.retainCurrentTranscript();

    const scroll = this.controller.state.transcript.scroll;
    this.controller.selectTranscript(selectedRunId);
    if (!resetViewport) {
      this.controller.dispatch({ type: "scroll.set", paneId: "transcript", scroll });
    }
  }

  async whenIdle(): Promise<void> {
    await this.controller.whenIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeController();
    this.unsubscribeSource();
    this.controller.dispose();
    this.listeners.clear();
  }

  private handleControllerChange(): void {
    const nextSnapshot = this.controller.snapshot;
    if (nextSnapshot && nextSnapshot !== this.lastSnapshot) {
      this.lastSnapshot = nextSnapshot;
      this.reloadTranscript();
    }
    this.publishChange();
  }

  private reloadTranscript(): void {
    this.retainCurrentTranscript();
    const selectedRunId = this.controller.state.panes.runs.selectedItemId;
    this.selectTranscript(this.controller.state.activeRunId, false);
    if (selectedRunId && selectedRunId !== this.controller.state.panes.runs.selectedItemId) {
      this.controller.dispatch({
        type: "selection.set",
        paneId: "runs",
        itemId: selectedRunId,
      });
    }
  }

  private retainCurrentTranscript(): void {
    const transcript = this.controller.currentTranscript;
    if (transcript === undefined) return;
    this.retainedTranscript = {
      runId: this.controller.state.activeRunId,
      transcript,
    };
  }

  private publishChange(): void {
    const previous = this.observation;
    const next = this.captureObservation();
    this.observation = next;

    const dirtySurfaces = new Set(changedSurfaces(previous, next));
    if (this.suppressRunSurfaceChanges) dirtySurfaces.delete("runs");
    const layoutChanged = previous.state.sidebarVisible !== next.state.sidebarVisible;
    if (dirtySurfaces.size === 0 && !layoutChanged) return;

    this.changeRevision += 1;
    const change: WorkspaceFrontendChange = {
      revision: this.changeRevision,
      dirtySurfaces,
      layoutChanged,
    };
    for (const listener of this.listeners) listener(change);
  }

  private captureObservation(): WorkspaceFrontendObservation<TSnapshot, TTranscript> {
    const transcript = this.transcript;
    return {
      state: this.controller.state,
      snapshot: this.controller.snapshot ?? this.lastSnapshot,
      ...(transcript !== undefined ? { transcript } : {}),
    };
  }
}

function initialState<TSnapshot, TTranscript>(
  snapshot: WorkspaceSnapshotEnvelope<TSnapshot>,
  transcript: ReadyWorkspaceTranscript<TTranscript>,
): WorkspaceState {
  const state = createInitialWorkspaceState(snapshot.rootRunId);
  return {
    ...state,
    snapshotRevision: snapshot.revision,
    transcript: {
      runId: snapshot.rootRunId,
      availability: { kind: "ready", transcript: transcript.handle },
      scroll: { mode: "follow-end" },
      horizontalOrigin: 0,
    },
  };
}

function changedSurfaces<TSnapshot, TTranscript>(
  previous: WorkspaceFrontendObservation<TSnapshot, TTranscript>,
  next: WorkspaceFrontendObservation<TSnapshot, TTranscript>,
): ReadonlySet<WorkspaceSurfaceId> {
  const dirty = new Set<WorkspaceSurfaceId>();
  if (previous.snapshot !== next.snapshot) addAllSurfaces(dirty);

  for (const id of WORKSPACE_SURFACE_IDS) {
    if (previous.state.panes[id] !== next.state.panes[id]) dirty.add(id);
  }

  if (
    previous.state.transcript !== next.state.transcript ||
    previous.transcript !== next.transcript
  ) {
    dirty.add("transcript");
  }
  if (previous.state.activeRunId !== next.state.activeRunId) {
    dirty.add("transcript");
    dirty.add("runs");
    dirty.add("tasks");
    dirty.add("files");
  }
  if (previous.state.focusedPaneId !== next.state.focusedPaneId) {
    dirty.add(asSurfaceId(previous.state.focusedPaneId));
    dirty.add(asSurfaceId(next.state.focusedPaneId));
  }
  if (previous.state.sidebarVisible !== next.state.sidebarVisible) addAllSurfaces(dirty);
  return dirty;
}

function addAllSurfaces(target: Set<WorkspaceSurfaceId>): void {
  for (const id of WORKSPACE_SURFACE_IDS) target.add(id);
}

function asSurfaceId(paneId: PaneId): WorkspaceSurfaceId {
  return paneId;
}
