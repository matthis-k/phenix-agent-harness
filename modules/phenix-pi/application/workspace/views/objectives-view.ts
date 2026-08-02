import type { ObjectiveNode } from "../../../domain/objective/projection.ts";
import { textSpan, type WorkspaceRowPresentation } from "../presentation.ts";
import { defineWorkspaceView, workspaceViewLayout } from "./workspace-view.ts";
import {
  objectiveStateLabel,
  objectiveStateSymbol,
  objectiveStateTone,
  truncateWorkspaceText,
} from "./workspace-view-format.ts";

export interface WorkspaceObjectiveRow {
  readonly node: ObjectiveNode;
  readonly depth: number;
}

export function projectWorkspaceObjectives(
  roots: readonly ObjectiveNode[],
): readonly WorkspaceObjectiveRow[] {
  const result: WorkspaceObjectiveRow[] = [];
  const visit = (node: ObjectiveNode, depth: number): void => {
    result.push({ node, depth });
    if (node.effectiveState === "done" && node.children.length > 0) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return result;
}

export const objectivesWorkspaceView = defineWorkspaceView<WorkspaceObjectiveRow>({
  id: "objectives",
  title: "Objectives",
  layout: workspaceViewLayout("objectives"),
  project: (snapshot) =>
    projectWorkspaceObjectives(snapshot.objectives?.roots ?? []).map((value) => {
      const node = value.node;
      const models = [...new Set(node.workers.map((worker) => worker.model))];
      const expandable = Boolean(
        node.description || node.progress.length > 0 || models.length > 0,
      );
      const present = ({
        width,
        expanded,
      }: {
        readonly width: number;
        readonly expanded: boolean;
      }): WorkspaceRowPresentation => {
        const details = expanded
          ? [
              node.source === "discovered" ? "discovered" : undefined,
              models.length > 0 ? `working: ${models.join(", ")}` : undefined,
              node.progress.at(-1),
            ].filter((detail): detail is string => Boolean(detail))
          : [];
        const disclosure = expandable ? (expanded ? "▾" : "▸") : " ";
        return {
          active: node.workers.length > 0,
          spans: [
            textSpan(`${"  ".repeat(value.depth)}${disclosure} `),
            textSpan(
              `${objectiveStateSymbol(node.effectiveState)} ${objectiveStateLabel(node.effectiveState)}`,
              { tone: objectiveStateTone(node.effectiveState) },
            ),
            textSpan(" "),
            textSpan(
              truncateWorkspaceText(node.title, Math.max(8, width - 18 - value.depth * 2)),
              { strong: true },
            ),
            ...(details.length > 0
              ? [textSpan(` · ${details.join(" · ")}`, { tone: "dim" as const })]
              : []),
          ],
        };
      };
      return {
        id: node.id,
        value,
        expandable,
        ...(node.workers[0]
          ? { activation: { kind: "transcript" as const, runId: node.workers[0].runId } }
          : {}),
        present,
      };
    }),
});
