import { defineWorkspaceView } from "./workspace-view.ts";

export interface WorkspaceFileRow {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

export const filesWorkspaceView = defineWorkspaceView<WorkspaceFileRow>({
  id: "files",
  title: "Files",
  layout: {
    weight: 3,
    minRows: 2,
    headerRows: 2,
    collapsePriority: 30,
  },
  project: () => [],
});
