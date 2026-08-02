import { isTerminalRunState } from "../run/invariants.ts";
import type { RunRecord } from "../run/model.ts";
import type { RunProjection } from "../run/reducer.ts";
import type { ObjectiveId, ObjectiveState, RunId } from "../shared.ts";
import type { Objective } from "./model.ts";

export interface ObjectiveWorker {
  readonly runId: RunId;
  readonly model: string;
}

export interface ObjectiveNode extends Objective {
  readonly effectiveState: ObjectiveState;
  readonly progress: readonly string[];
  readonly workers: readonly ObjectiveWorker[];
  readonly children: readonly ObjectiveNode[];
}

export interface ObjectiveFocus {
  readonly id: ObjectiveId;
  readonly title: string;
  readonly state: ObjectiveState;
  readonly effectiveState: ObjectiveState;
}

export interface ObjectiveTree {
  readonly roots: readonly ObjectiveNode[];
  readonly focusByRun: Readonly<Record<string, ObjectiveFocus>>;
}

export function projectObjectiveTree(projection: RunProjection, rootRunId: RunId): ObjectiveTree {
  const objectives = [...projection.objectives.values()]
    .filter((objective) => objective.rootRunId === rootRunId)
    .sort(byCreation);
  const childrenByParent = new Map<ObjectiveId, Objective[]>();
  for (const objective of objectives) {
    if (!objective.parentObjectiveId) continue;
    const children = childrenByParent.get(objective.parentObjectiveId) ?? [];
    children.push(objective);
    childrenByParent.set(objective.parentObjectiveId, children);
  }

  const workersByObjective = new Map<ObjectiveId, ObjectiveWorker[]>();
  for (const run of projection.runs.values()) {
    if (projection.rootOf(run.id) !== rootRunId || isTerminalRunState(run.state)) continue;
    const objectiveId = focusedObjectiveId(projection, run.id);
    if (!objectiveId) continue;
    const workers = workersByObjective.get(objectiveId) ?? [];
    workers.push({ runId: run.id, model: runModelLabel(run) });
    workersByObjective.set(objectiveId, workers);
  }

  const byId = new Map<ObjectiveId, ObjectiveNode>();
  const build = (objective: Objective, ancestry: ReadonlySet<ObjectiveId>): ObjectiveNode => {
    if (ancestry.has(objective.id)) {
      throw new Error(`Objective projection found cycle at ${objective.id}`);
    }
    const nextAncestry = new Set(ancestry).add(objective.id);
    const children = (childrenByParent.get(objective.id) ?? [])
      .sort(byCreation)
      .map((child) => build(child, nextAncestry));
    const node: ObjectiveNode = {
      ...objective,
      effectiveState: effectiveObjectiveState(objective.state, children),
      progress: projection.objectiveProgress.get(objective.id) ?? [],
      workers: (workersByObjective.get(objective.id) ?? []).sort((left, right) =>
        String(left.runId).localeCompare(String(right.runId)),
      ),
      children,
    };
    byId.set(node.id, node);
    return node;
  };

  const roots = objectives
    .filter((objective) => !objective.parentObjectiveId)
    .map((objective) => build(objective, new Set()));
  const focusByRun: Record<string, ObjectiveFocus> = {};
  for (const run of projection.runs.values()) {
    if (projection.rootOf(run.id) !== rootRunId) continue;
    const objectiveId = focusedObjectiveId(projection, run.id);
    if (!objectiveId) continue;
    const objective = byId.get(objectiveId);
    if (!objective) continue;
    focusByRun[String(run.id)] = {
      id: objective.id,
      title: objective.title,
      state: objective.state,
      effectiveState: objective.effectiveState,
    };
  }
  return { roots, focusByRun };
}

export function focusedObjectiveId(
  projection: Pick<RunProjection, "objectiveFocuses" | "requireRun">,
  runId: RunId,
): ObjectiveId | undefined {
  let current = projection.requireRun(runId);
  const visited = new Set<RunId>();
  while (true) {
    if (visited.has(current.id)) throw new Error(`Run ancestry cycle at ${current.id}`);
    visited.add(current.id);
    const focused = projection.objectiveFocuses.get(current.id);
    if (focused) return focused;
    if (!current.parentId) return undefined;
    current = projection.requireRun(current.parentId);
  }
}

export function effectiveObjectiveState(
  ownState: ObjectiveState,
  children: readonly Pick<ObjectiveNode, "effectiveState">[],
): ObjectiveState {
  if (ownState === "blocked" || children.some((child) => child.effectiveState === "blocked")) {
    return "blocked";
  }
  if (ownState === "done" && children.every((child) => child.effectiveState === "done")) {
    return "done";
  }
  if (
    ownState === "wip" ||
    ownState === "done" ||
    children.some((child) => child.effectiveState !== "not_started")
  ) {
    return "wip";
  }
  return "not_started";
}

export function objectiveContains(
  projection: Pick<RunProjection, "objectives">,
  ancestorId: ObjectiveId,
  candidateId: ObjectiveId,
): boolean {
  let current = projection.objectives.get(candidateId);
  const visited = new Set<ObjectiveId>();
  while (current) {
    if (current.id === ancestorId) return true;
    if (visited.has(current.id)) throw new Error(`Objective ancestry cycle at ${current.id}`);
    visited.add(current.id);
    current = current.parentObjectiveId
      ? projection.objectives.get(current.parentObjectiveId)
      : undefined;
  }
  return false;
}

function runModelLabel(run: RunRecord): string {
  if (run.resolvedModel?.virtual) {
    return `${run.resolvedModel.virtual.provider}/${run.resolvedModel.virtual.model}`;
  }
  if (run.resolvedModel) {
    return `${run.resolvedModel.concrete.provider}/${run.resolvedModel.concrete.model}`;
  }
  if (run.profile) return `phenix/${run.profile.modelSet}`;
  if (run.observedModel?.kind === "concrete") {
    return `${run.observedModel.provider}/${run.observedModel.model}`;
  }
  if (run.observedModel?.kind === "virtual") {
    return `${run.observedModel.provider}/${run.observedModel.model}`;
  }
  return run.kind;
}

function byCreation(left: Objective, right: Objective): number {
  return left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id));
}
