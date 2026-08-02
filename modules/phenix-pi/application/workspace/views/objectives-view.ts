import type { ObjectiveId } from "../../../domain/shared.ts";
import type { ObjectiveNode } from "../../../domain/objective/projection.ts";
import {
  objectiveStateLabel,
  objectiveStateSymbol,
  objectiveStateTone,
} from "./workspace-view-format.ts";
import type {
  WorkspaceViewAction,
  WorkspaceViewRegistration,
  WorkspaceViewRow,
  WorkspaceViewSnapshot,
} from "./workspace-view.ts";

export interface WorkspaceObjectiveRow extends WorkspaceViewRow {
  readonly objectiveId: ObjectiveId;
}

export function projectWorkspaceObjectives(
  snapshot: WorkspaceViewSnapshot,
  expandedIds: ReadonlySet<string>,
): readonly WorkspaceObjectiveRow[] {
  const output: WorkspaceObjectiveRow[] = [];
  for (const root of snapshot.objectives.roots) appendObjective(output, root, 0, expandedIds);
  return output;
}

export const objectivesWorkspaceView: WorkspaceViewRegistration = {
  id: "objectives",
  surfaceId: "objectives",
  title: "Objectives",
  defaultFraction: 0.28,
  minSize: 5,
  collapsible: true,
  rows: (snapshot, input) => projectWorkspaceObjectives(snapshot, input.expandedIds),
  activate(row, snapshot): WorkspaceViewAction {
    const objective = findObjective(snapshot.objectives.roots, row.id as ObjectiveId);
    const worker = objective?.workers[0];
    return worker ? { kind: "select-run", runId: worker.runId } : { kind: "none" };
  },
};

function appendObjective(
  output: WorkspaceObjectiveRow[],
  objective: ObjectiveNode,
  depth: number,
  expandedIds: ReadonlySet<string>,
): void {
  const expandable = objective.children.length > 0;
  const expanded = expandable && (expandedIds.has(objective.id) || objective.effectiveState !== "done");
  const models = [...new Set(objective.workers.map((worker) => worker.model))];
  const source = objective.source === "discovered" ? "discovered" : undefined;
  const progress = objective.progress.at(-1);
  const detail = [source, models.length > 0 ? models.join(", ") : undefined, progress]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  output.push({
    id: objective.id,
    objectiveId: objective.id,
    depth,
    marker: expandable ? (expanded ? "▾" : "▸") : " ",
    state: objectiveStateLabel(objective.effectiveState),
    stateTone: objectiveStateTone(objective.effectiveState),
    label: objective.title,
    ...(detail ? { detail } : {}),
    expanded,
    expandable,
    active: objective.workers.length > 0,
  });
  if (!expanded) return;
  for (const child of objective.children) appendObjective(output, child, depth + 1, expandedIds);
}

function findObjective(
  roots: readonly ObjectiveNode[],
  targetId: ObjectiveId,
): ObjectiveNode | undefined {
  const pending = [...roots];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) break;
    if (current.id === targetId) return current;
    pending.push(...current.children);
  }
  return undefined;
}

export function objectiveRowSymbol(row: WorkspaceObjectiveRow): string {
  const objectiveState = row.state === "DONE" ? "done" : row.state === "BLOCKED" ? "blocked" : row.state === "ACTIVE" ? "wip" : "not_started";
  return objectiveStateSymbol(objectiveState);
}
