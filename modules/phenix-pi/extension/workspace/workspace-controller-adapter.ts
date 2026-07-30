import type { RunTreeNode } from "../../application/interfaces.ts";
import { WorkspaceFrontend } from "../../application/workspace/frontend.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type { WorkspaceSnapshotEnvelope } from "../../domain/workspace/events.ts";
import type { LoadedWorkspaceTranscript } from "../../ports/workspace-effects.ts";
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

export class WorkspaceControllerAdapter extends WorkspaceFrontend<
  PhenixWorkspaceSnapshot,
  NativeRunTranscript
> {
  private readonly unsubscribeHost: () => void;

  constructor(options: WorkspaceControllerAdapterOptions) {
    super({
      initialSnapshot: snapshotEnvelope(options.snapshot),
      initialTranscript: options.snapshot.rootTranscript,
      loadSnapshot: async () => snapshotEnvelope(await options.load()),
      loadTranscript: async (runId, snapshot) => {
        const node = findWorkspaceRun(snapshot.ui.tree.root, String(runId));
        if (!node) {
          throw new Error(`Run ${runId} is not present in the current workspace snapshot`);
        }
        return node.run.kind === "root" ? snapshot.rootTranscript : options.loadTranscript(node);
      },
      subscribeSource: options.subscribe,
      ...(options.recordDiagnostic ? { recordDiagnostic: options.recordDiagnostic } : {}),
    });
    this.unsubscribeHost = this.subscribe(options.onChange);
  }

  override dispose(): void {
    this.unsubscribeHost();
    super.dispose();
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
