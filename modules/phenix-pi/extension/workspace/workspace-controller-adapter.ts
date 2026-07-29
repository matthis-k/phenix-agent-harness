import type { RunTreeNode } from "../../application/interfaces.ts";
import { WorkspaceController } from "../../application/workspace/controller.ts";
import type { RunId } from "../../domain/shared.ts";
import type {
  WorkspaceEvent,
  WorkspaceSnapshotEnvelope,
} from "../../domain/workspace/events.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import {
  createInitialWorkspaceState,
  type WorkspaceState,
} from "../../domain/workspace/state.ts";
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
  readonly loadTranscript: (node: RunTreeNode) => Promise<NativeRunTranscript>;
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
    const initialTranscript = loadedTranscript(
      initialSnapshot.rootRunId,
      options.snapshot.rootTranscript,
    );
    this.lastSnapshot = initialSnapshot;

    let controller!: WorkspaceController<PhenixWorkspaceSnapshot, NativeRunTranscript>;
    const runtime: WorkspaceEffectRuntime<PhenixWorkspaceSnapshot, NativeRunTranscript> = {
      loadSnapshot: async () => snapshotEnvelope(await options.load()),
      loadTranscript: async (selectedRunId) => {
        const snapshot = controller.snapshot?.value ?? options.snapshot;
        const node = findWorkspaceRun(snapshot.ui.tree.root, String(selectedRunId));
        if (!node) throw new Error(`Run ${selectedRunId} is not present in the current workspace snapshot`);
        const loaded =
          node.run.kind === "root" ? snapshot.rootTranscript : await options.loadTranscript(node);
        return loadedTranscript(selectedRunId, normalizeTranscript(node, loaded));
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

  get transcript(): NativeRunTranscript {
    const current = this.controller.currentTranscript;
    if (current) return current;
    if (this.controller.state.activeRunId === this.snapshot.ui.tree.root.run.id) {
      return this.snapshot.rootTranscript;
    }
    const availability = this.controller.state.transcript.availability;
    if (availability.kind === "pending") {
      return { unavailable: "Loading Pi transcript…" };
    }
    if (availability.kind === "legacy") {
      return { unavailable: "This persisted run predates Pi transcript persistence." };
    }
    if (availability.kind === "not-applicable") {
      return { unavailable: "This run does not own a Pi transcript." };
    }
    if (availability.kind === "invalid" || availability.kind === "invariant-violation") {
      return { unavailable: availability.reason };
    }
    return { unavailable: "Transcript data is unavailable." };
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

function loadedTranscript(
  selectedRunId: RunId,
  transcript: NativeRunTranscript,
): LoadedWorkspaceTranscript<NativeRunTranscript> {
  return {
    handle: {
      key:
        transcript.sessionFile ??
        transcript.sessionId ??
        `run:${String(selectedRunId)}:transcript`,
    },
    value: transcript,
  };
}

function normalizeTranscript(
  node: RunTreeNode,
  transcript: NativeRunTranscript,
): NativeRunTranscript {
  if (!transcript.unavailable?.startsWith("This run has no Pi transcript reference")) {
    return transcript;
  }
  if (node.run.kind === "workflow") {
    return {
      ...(transcript.sessionId ? { sessionId: transcript.sessionId } : {}),
      ...(transcript.sessionFile ? { sessionFile: transcript.sessionFile } : {}),
      unavailable: "This workflow run does not own a Pi transcript.",
    };
  }
  if (node.run.pi?.sessionId) {
    return {
      sessionId: node.run.pi.sessionId,
      ...(node.run.pi.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
      unavailable: "Pi has allocated this transcript but has not persisted it yet.",
    };
  }
  return {
    unavailable: "This agent run has no persisted Pi transcript reference.",
  };
}

function initialState(
  snapshot: WorkspaceSnapshotEnvelope<PhenixWorkspaceSnapshot>,
  transcript: LoadedWorkspaceTranscript<NativeRunTranscript>,
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
