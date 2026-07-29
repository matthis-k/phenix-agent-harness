import type { RunTreeNode } from "../../application/interfaces.ts";
import { WorkspaceController } from "../../application/workspace/controller.ts";
import type { RunId } from "../../domain/shared.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type { WorkspaceEvent, WorkspaceSnapshotEnvelope } from "../../domain/workspace/events.ts";
import { createInitialWorkspaceState, type WorkspaceState } from "../../domain/workspace/state.ts";
import type {
  LoadedWorkspaceTranscript,
  WorkspaceEffectRuntime,
} from "../../ports/workspace-effects.ts";
import type { NativeRunTranscript } from "../native-run-transcript.ts";
import {
  findWorkspaceRun,
  type PhenixWorkspaceSnapshot,
  workspaceItemIndex,
} from "./workspace-model.ts";

export interface WorkspaceControllerAdapterOptions {
  readonly snapshot: PhenixWorkspaceSnapshot;
  readonly load: () => Promise<PhenixWorkspaceSnapshot>;
  readonly loadTranscript: (
    node: RunTreeNode,
  ) => Promise<LoadedWorkspaceTranscript<NativeRunTranscript>>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly onChange: () => void;
  readonly recordDiagnostic?: (error: WorkspaceError) => void | Promise<void>;
}

export class WorkspaceControllerAdapter {
  private readonly controller: WorkspaceController<PhenixWorkspaceSnapshot, NativeRunTranscript>;
  private readonly unsubscribeController: () => void;
  private readonly unsubscribeSource: () => void;
  private lastSnapshot: WorkspaceSnapshotEnvelope<PhenixWorkspaceSnapshot>;
  private disposed = false;

  constructor(options: WorkspaceControllerAdapterOptions) {
    const initialSnapshot = snapshotEnvelope(options.snapshot);
    const initialTranscript = options.snapshot.rootTranscript;
    this.lastSnapshot = initialSnapshot;

    let controller!: WorkspaceController<PhenixWorkspaceSnapshot, NativeRunTranscript>;
    const runtime: WorkspaceEffectRuntime<PhenixWorkspaceSnapshot, NativeRunTranscript> = {
      loadSnapshot: async () => snapshotEnvelope(await options.load()),
      loadTranscript: async (selectedRunId) => {
        const snapshot = controller.snapshot?.value ?? options.snapshot;
        const node = findWorkspaceRun(snapshot.ui.tree.root, String(selectedRunId));
        if (!node) {
          throw new Error(`Run ${selectedRunId} is not present in the current workspace snapshot`);
        }
        return node.run.kind === "root" ? snapshot.rootTranscript : options.loadTranscript(node);
      },
      recordDiagnostic: (error) => options.recordDiagnostic?.(error),
    };

    controller = new WorkspaceController({
      state: initialState(initialSnapshot, initialTranscript),
      runtime,
      snapshot: initialSnapshot,
      transcript: initialTranscript,
    });
    this.controller = controller;
    this.unsubscribeController = controller.subscribe(() => {
      const nextSnapshot = controller.snapshot;
      if (nextSnapshot && nextSnapshot !== this.lastSnapshot) {
        this.lastSnapshot = nextSnapshot;
        this.reloadTranscript();
      }
      options.onChange();
    });
    this.unsubscribeSource = options.subscribe(() => controller.invalidateSnapshot());
  }

  get state(): WorkspaceState {
    return this.controller.state;
  }

  get snapshot(): PhenixWorkspaceSnapshot {
    return this.controller.snapshot?.value ?? this.lastSnapshot.value;
  }

  get transcript(): NativeRunTranscript | undefined {
    const current = this.controller.currentTranscript;
    if (current) return current;
    return this.controller.state.activeRunId === this.snapshot.ui.tree.root.run.id
      ? this.snapshot.rootTranscript.value
      : undefined;
  }

  dispatch(event: WorkspaceEvent<PhenixWorkspaceSnapshot>): void {
    this.controller.dispatch(event);
  }

  invalidateSnapshot(): void {
    this.controller.invalidateSnapshot();
  }

  selectTranscript(selectedRunId: RunId, resetViewport = true): void {
    const scroll = this.controller.state.transcript.scroll;
    this.controller.selectTranscript(selectedRunId);
    if (!resetViewport) {
      this.controller.dispatch({ type: "scroll.set", paneId: "transcript", scroll });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeController();
    this.unsubscribeSource();
    this.controller.dispose();
  }

  private reloadTranscript(): void {
    this.selectTranscript(this.controller.state.activeRunId, false);
  }
}

function snapshotEnvelope(
  snapshot: PhenixWorkspaceSnapshot,
): WorkspaceSnapshotEnvelope<PhenixWorkspaceSnapshot> {
  return {
    revision: snapshot.ui.sequence,
    rootRunId: snapshot.ui.tree.root.run.id,
    itemIds: workspaceItemIndex(snapshot),
    value: snapshot,
  };
}

function initialState(
  snapshot: WorkspaceSnapshotEnvelope<PhenixWorkspaceSnapshot>,
  transcript: PhenixWorkspaceSnapshot["rootTranscript"],
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
