import type { RunTreeNode } from "../../application/interfaces.ts";
import type { WorkspaceItemIndex } from "../../domain/workspace/events.ts";
import type { ReadyWorkspaceTranscript } from "../../ports/workspace-effects.ts";
import type { NativeRunTranscript } from "../native-run-transcript.ts";
import type { PhenixUiSnapshot } from "../phenix-ui.ts";
import type { WorkspaceViewSnapshot } from "./views/workspace-view.ts";
import { workspaceViewRegistry } from "./views/workspace-view-registry.ts";

export type { WorkspaceFileRow } from "./views/files-view.ts";
export { projectWorkspaceFiles } from "./views/files-view.ts";
export type { WorkspaceRunRow } from "./views/runs-view.ts";
export { projectWorkspaceRuns } from "./views/runs-view.ts";
export type { WorkspaceTaskRow } from "./views/tasks-view.ts";
export { projectWorkspaceTasks } from "./views/tasks-view.ts";

export interface PhenixWorkspaceSnapshot extends WorkspaceViewSnapshot {
  readonly ui: PhenixUiSnapshot;
  readonly rootTranscript: ReadyWorkspaceTranscript<NativeRunTranscript>;
}

export function workspaceItemIndex(snapshot: PhenixWorkspaceSnapshot): WorkspaceItemIndex {
  const itemIds: Record<keyof WorkspaceItemIndex, string[]> = {
    transcript: [],
    editor: [],
    runs: [],
    tasks: [],
    files: [],
    facts: [],
  };
  for (const view of workspaceViewRegistry.ordered) {
    itemIds[view.id] = view.project(snapshot).map((row) => row.id);
  }
  return itemIds;
}

export function findWorkspaceRun(root: RunTreeNode, id: string): RunTreeNode | undefined {
  if (String(root.run.id) === id) return root;
  for (const child of root.children) {
    const found = findWorkspaceRun(child, id);
    if (found) return found;
  }
  return undefined;
}
