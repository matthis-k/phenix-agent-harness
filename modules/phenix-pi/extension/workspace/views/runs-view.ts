import type { RunTreeNode } from "../../../application/interfaces.ts";
import { color } from "../../observability-theme.ts";
import {
  definitionLabel,
  runStateSymbol,
  truncateWorkspaceText,
} from "./workspace-view-format.ts";
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
      activation: { kind: "transcript", runId: value.node.run.id },
      render: ({ theme, width, activeRunId }) => {
        const run = value.node.run;
        const active = run.id === activeRunId;
        const model = run.resolvedModel
          ? ` ${color(theme, "muted", `${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`)}`
          : "";
        const activity = value.node.activity?.summary
          ? ` ${color(
              theme,
              "muted",
              truncateWorkspaceText(
                value.node.activity.summary,
                Math.max(8, width - 24 - value.depth * 2),
              ),
            )}`
          : "";
        const label =
          run.kind === "root" ? "Root session" : definitionLabel(String(run.definitionId));
        return {
          active,
          text: `${active ? "◆" : " "} ${"  ".repeat(value.depth)}${runStateSymbol(run.state)} ${label} ${run.state}${model}${TERMINAL_STATES.has(run.state) ? "" : activity}`,
        };
      },
    })),
});
