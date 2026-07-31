import type { TaskNode } from "../../../domain/task/projection.ts";
import { textSpan, type WorkspaceRowPresentation } from "../presentation.ts";
import { defineWorkspaceView, workspaceViewLayout } from "./workspace-view.ts";
import {
  taskStateLabel,
  taskStateSymbol,
  taskStateTone,
  truncateWorkspaceText,
} from "./workspace-view-format.ts";

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
  layout: workspaceViewLayout("tasks"),
  project: (snapshot) =>
    projectWorkspaceTasks(snapshot.tasks.root).map((value) => {
      const assignments =
        value.node.kind === "local"
          ? value.node.assignedRuns.map((assignment) => assignment.title)
          : [];
      const present = ({ width }: { readonly width: number }): WorkspaceRowPresentation => {
        const assignmentText =
          assignments.length === 0
            ? ""
            : assignments.length === 1
              ? ` · ${assignments[0]}`
              : ` · ${assignments.length} runs`;
        return {
          spans: [
            textSpan("  ".repeat(value.depth)),
            textSpan(
              `${taskStateSymbol(value.node.effectiveState)} ${taskStateLabel(value.node.effectiveState)}`,
              { tone: taskStateTone(value.node.effectiveState) },
            ),
            textSpan(" "),
            textSpan(
              truncateWorkspaceText(
                value.node.title,
                Math.max(8, width - 13 - value.depth * 2 - assignmentText.length),
              ),
              { strong: true },
            ),
            ...(assignmentText
              ? [
                  textSpan(truncateWorkspaceText(assignmentText, Math.max(8, width / 2)), {
                    tone: "muted" as const,
                  }),
                ]
              : []),
          ],
        };
      };
      return {
        id: value.node.id,
        value,
        present,
      };
    }),
});
