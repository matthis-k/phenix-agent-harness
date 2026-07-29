import type { RunTreeNode } from "../../../application/interfaces.ts";
import { defineWorkspaceView } from "./workspace-view.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);

export interface WorkspaceRunRow {
  readonly node: RunTreeNode;
  readonly depth: number;
}

export function projectWorkspaceRuns(root: RunTreeNode): readonly WorkspaceRunRow[] {
  const result: WorkspaceRunRow[] = [];
  const visit = (node: RunTreeNode, depth: number): void => {
    result.push({ node, depth });
    const autoCollapsed =
      node.run.kind !== "root" && TERMINAL_STATES.has(node.run.state) && node.children.length > 0;
    if (autoCollapsed) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return result;
}

export const runsWorkspaceView = defineWorkspaceView<WorkspaceRunRow>({
  id: "runs",
  title: "Runs",
  layout: {
    weight: 5,
    minRows: 2,
    headerRows: 2,
    collapsePriority: 0,
  },
  project: (snapshot) =>
    projectWorkspaceRuns(snapshot.ui.tree.root).map((value) => ({
      id: String(value.node.run.id),
      value,
    })),
});
