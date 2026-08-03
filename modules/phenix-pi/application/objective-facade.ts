import type { Objective } from "../domain/objective/model.ts";
import {
  focusedObjectiveId,
  type ObjectiveNode,
  type ObjectiveTree,
  objectiveContains,
  projectObjectiveTree,
} from "../domain/objective/projection.ts";
import type { PendingDomainEvent } from "../domain/run/events.ts";
import {
  type ObjectiveId,
  type ObjectiveState,
  objectiveId,
  type RunId,
} from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ObjectiveFacade } from "./interfaces.ts";

export class ObjectiveFacadeImpl implements ObjectiveFacade {
  private readonly store: ExecutionStore;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(input: {
    readonly store: ExecutionStore;
    readonly clock: Clock;
    readonly ids: IdGenerator;
  }) {
    this.store = input.store;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  async tree(rootRunId: RunId): Promise<ObjectiveTree> {
    this.store.projection.requireRun(rootRunId);
    return projectObjectiveTree(this.store.projection, rootRunId);
  }

  async current(runId: RunId): Promise<ObjectiveNode | undefined> {
    const rootRunId = this.store.projection.rootOf(runId);
    const currentId = focusedObjectiveId(this.store.projection, runId);
    if (!currentId) return undefined;
    return findObjectiveNode((await this.tree(rootRunId)).roots, currentId);
  }

  async add(input: {
    readonly actorRunId: RunId;
    readonly parentObjectiveId?: ObjectiveId;
    readonly title: string;
    readonly description?: string;
    readonly focus?: boolean;
  }): Promise<Objective> {
    const actor = this.store.projection.requireRun(input.actorRunId);
    const rootRunId = this.store.projection.rootOf(actor.id);
    const title = input.title.trim();
    if (!title) throw new Error(`Objective title must not be empty`);
    if (!input.parentObjectiveId && actor.kind !== "root") {
      throw new Error(`Only the root session may create top-level objectives`);
    }
    if (input.parentObjectiveId) {
      this.requireAccessible(actor.id, input.parentObjectiveId);
    }
    const now = this.clock.now();
    const objective: Objective = {
      id: objectiveId(this.ids.next("objective")),
      rootRunId,
      ...(input.parentObjectiveId ? { parentObjectiveId: input.parentObjectiveId } : {}),
      createdByRunId: actor.id,
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      source: input.parentObjectiveId ? "discovered" : "user",
      state: "not_started",
      createdAt: now,
      updatedAt: now,
    };
    const events: PendingDomainEvent[] = [
      { runId: actor.id, type: "objective.created", data: { objective } },
    ];
    if (input.focus !== false) {
      events.push({
        runId: actor.id,
        type: "objective.focus.changed",
        data: { objectiveId: objective.id },
      });
    }
    await this.store.commit(rootRunId, events);
    return this.requireObjective(objective.id);
  }

  async setState(
    actorRunId: RunId,
    targetId: ObjectiveId,
    state: ObjectiveState,
  ): Promise<Objective> {
    this.requireAccessible(actorRunId, targetId);
    const rootRunId = this.store.projection.rootOf(actorRunId);
    await this.store.commit(rootRunId, [
      {
        runId: actorRunId,
        type: "objective.state.changed",
        data: { objectiveId: targetId, state, updatedAt: this.clock.now() },
      },
    ]);
    return this.requireObjective(targetId);
  }

  async focus(runId: RunId, targetId: ObjectiveId): Promise<Objective> {
    const run = this.store.projection.requireRun(runId);
    const target = this.requireObjective(targetId);
    if (target.rootRunId !== this.store.projection.rootOf(run.id)) {
      throw new Error(`Objective ${targetId} is outside run ${runId}`);
    }
    if (run.kind !== "root") {
      const currentId = focusedObjectiveId(this.store.projection, run.id);
      if (
        !currentId ||
        (!objectiveContains(this.store.projection, currentId, targetId) &&
          !objectiveContains(this.store.projection, targetId, currentId))
      ) {
        throw new Error(`Run ${runId} may focus only its current objective branch`);
      }
    }
    await this.store.commit(target.rootRunId, [
      { runId, type: "objective.focus.changed", data: { objectiveId: targetId } },
    ]);
    return target;
  }

  async appendProgress(actorRunId: RunId, targetId: ObjectiveId, message: string): Promise<void> {
    this.requireAccessible(actorRunId, targetId);
    const text = message.trim();
    if (!text) throw new Error(`Objective progress must not be empty`);
    await this.store.commit(this.store.projection.rootOf(actorRunId), [
      {
        runId: actorRunId,
        type: "objective.progress.appended",
        data: { objectiveId: targetId, message: text },
      },
    ]);
  }

  private requireAccessible(actorRunId: RunId, targetId: ObjectiveId): Objective {
    const actor = this.store.projection.requireRun(actorRunId);
    const target = this.requireObjective(targetId);
    if (target.rootRunId !== this.store.projection.rootOf(actor.id)) {
      throw new Error(`Objective ${targetId} is outside run ${actorRunId}`);
    }
    if (actor.kind === "root") return target;
    const currentId = focusedObjectiveId(this.store.projection, actor.id);
    if (!currentId || !objectiveContains(this.store.projection, currentId, targetId)) {
      throw new Error(`Run ${actorRunId} may manage only its current objective or descendants`);
    }
    return target;
  }

  private requireObjective(id: ObjectiveId): Objective {
    const objective = this.store.projection.objectives.get(id);
    if (!objective) throw new Error(`Unknown objective: ${id}`);
    return objective;
  }
}

function findObjectiveNode(
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
