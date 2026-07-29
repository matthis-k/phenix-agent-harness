import type { RunTreeNode } from "../../../application/interfaces.ts";
import { color, state, strong } from "../../observability-theme.ts";
import { defineWorkspaceView } from "./workspace-view.ts";
import {
  definitionLabel,
  runStateLabel,
  runStateSymbol,
  truncateWorkspaceText,
} from "./workspace-view-format.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const GENERIC_ACTIVITIES = new Set(["working", "running", "waiting"]);

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
    projectWorkspaceRuns(snapshot.ui.tree.root).map((value) => {
      const run = value.node.run;
      const expandable = Boolean(run.resolvedModel || run.profile || run.pi?.sessionId);
      return {
        id: String(run.id),
        value,
        expandable,
        activation: { kind: "transcript" as const, runId: run.id },
        render: ({ theme, width, activeRunId, expanded }) => {
          const active = run.id === activeRunId;
          const label =
            run.kind === "root" ? "Root session" : definitionLabel(String(run.definitionId));
          const activity = activityText(value.node.activity?.summary, run.state, width, value.depth);
          const details = expanded ? runDetails(value.node) : [];
          const detailText =
            details.length > 0 ? ` ${color(theme, "dim", `· ${details.join(" · ")}`)}` : "";
          const disclosure = expandable ? (expanded ? "▾" : "▸") : " ";
          const status = state(
            theme,
            run.state,
            `${runStateSymbol(run.state)} ${runStateLabel(run.state)}`,
          );
          return {
            active,
            text: `${"  ".repeat(value.depth)}${disclosure} ${status} ${strong(theme, label)}${
              activity ? ` ${color(theme, "muted", activity)}` : ""
            }${detailText}`,
          };
        },
      };
    }),
});

function activityText(
  summary: string | undefined,
  runState: string,
  width: number,
  depth: number,
): string {
  if (!summary || TERMINAL_STATES.has(runState)) return "";
  const normalized = summary.trim().toLowerCase();
  if (!normalized || normalized === runState || GENERIC_ACTIVITIES.has(normalized)) return "";
  return truncateWorkspaceText(summary, Math.max(8, width - 22 - depth * 2));
}

function runDetails(node: RunTreeNode): string[] {
  const run = node.run;
  const details: string[] = [];
  if (run.resolvedModel) {
    details.push(`${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`);
  } else if (run.profile) {
    details.push(`${run.profile.modelSet}/${run.profile.difficulty}`);
  }
  if (run.pi?.sessionId) details.push(`session ${run.pi.sessionId}`);
  return details;
}
