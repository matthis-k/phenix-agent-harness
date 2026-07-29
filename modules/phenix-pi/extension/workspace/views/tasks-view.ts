import type { TaskNode } from "../../../domain/task/projection.ts";
import { defineWorkspaceView } from "./workspace-view.ts";

export interface WorkspaceTaskRow {
  readonly node: TaskNode;
  readonly depth: number;
}

export function projectWorkspaceTasks(root: TaskNode): readonly WorkspaceTaskRow[] {
  const result: WorkspaceTaskRow[] = [];
  const visit = (node: TaskNode, depth: number): void => {
    if (depth > 0) result.push({ node, depth: depth - 1 });
    if (node.effectiveState === "done" && node.children.length > 0) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return result;
}

export const tasksWorkspaceView = defineWorkspaceView<WorkspaceTaskRow>({
  id: "tasks",
  title: "Tasks",
  layout: {
    weight: 2,
    minRows: 2,
    headerRows: 2,
    collapsePriority: 20,
  },
  project: (snapshot) =>
    projectWorkspaceTasks(snapshot.tasks.root).map((value) => ({
      id: value.node.id,
      value,
    })),
});
