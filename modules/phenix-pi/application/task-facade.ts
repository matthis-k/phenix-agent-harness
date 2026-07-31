import {
  type DefinitionId,
  type LocalTaskId,
  localTaskId,
  type RunId,
  runId,
  type TaskId,
} from "../domain/shared.ts";
import type { LocalTask } from "../domain/task/local-task.ts";
import {
  findTask,
  projectTaskTree,
  type TaskNode,
  type TaskTree,
  tasksForRun,
} from "../domain/task/projection.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { TaskFacade } from "./interfaces.ts";

export class TaskFacadeImpl implements TaskFacade {
  private readonly store: ExecutionStore;
  private readonly catalog: DefinitionCatalog;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(input: {
    readonly store: ExecutionStore;
    readonly catalog: DefinitionCatalog;
    readonly clock: Clock;
    readonly ids: IdGenerator;
  }) {
    this.store = input.store;
    this.catalog = input.catalog;
    this.clock = input.clock;
    this.ids = input.ids;
  }

  async tree(rootRunId: RunId): Promise<TaskTree> {
    return projectTaskTree(this.store.projection, rootRunId, {
      title: (id) => {
        try {
          return this.catalog.require(id as DefinitionId).title;
        } catch {
          return undefined;
        }
      },
    });
  }

  async tasksFor(runId: RunId): Promise<readonly TaskNode[]> {
    const root = this.store.projection.rootOf(runId);
    return tasksForRun(await this.tree(root), runId);
  }

  async addLocal(input: {
    readonly ownerRunId: RunId;
    readonly parentId?: LocalTaskId;
    readonly title: string;
    readonly description?: string;
  }): Promise<LocalTask> {
    const title = input.title.trim();
    if (title.length === 0) throw new Error(`Local task title must not be empty`);
    const owner = this.store.projection.requireRun(input.ownerRunId);
    const root = this.store.projection.rootOf(owner.id);
    if (input.parentId) {
      const parent = this.store.projection.localTasks.get(input.parentId);
      if (!parent) throw new Error(`Unknown parent task: ${input.parentId}`);
      if (this.store.projection.rootOf(parent.ownerRunId) !== root) {
        throw new Error(`Parent task ${input.parentId} belongs to another root`);
      }
    }
    const now = this.clock.now();
    const task: LocalTask = {
      kind: "local",
      id: localTaskId(this.ids.next("task")),
      ownerRunId: owner.id,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      state: "not_started",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.commit(root, [
      { runId: owner.id, type: "task.local.created", data: { task } },
    ]);
    return this.store.projection.localTasks.get(task.id) as LocalTask;
  }

  async setLocalState(
    taskId: LocalTaskId,
    state: "not_started" | "wip" | "done" | "failed",
  ): Promise<LocalTask> {
    const task = this.store.projection.localTasks.get(taskId);
    if (!task) throw new Error(`Unknown local task: ${taskId}`);
    await this.store.commit(this.store.projection.rootOf(task.ownerRunId), [
      {
        runId: task.ownerRunId,
        type: "task.local.state.changed",
        data: { taskId, state, updatedAt: this.clock.now() },
      },
    ]);
    return this.store.projection.localTasks.get(taskId) as LocalTask;
  }

  async assignRun(taskId: LocalTaskId, runId: RunId): Promise<void> {
    const { root, task } = this.assignmentScope(taskId, runId);
    const projected = findTask(await this.tree(root), task.id);
    if (
      projected?.kind === "local" &&
      projected.assignedRuns.some((assignment) => assignment.runId === runId)
    ) {
      return;
    }
    await this.store.commit(root, [
      {
        runId,
        type: "task.run.assigned",
        data: { taskId: task.id, runId },
      },
    ]);
  }

  async unassignRun(taskId: LocalTaskId, runId: RunId): Promise<void> {
    const { root, task } = this.assignmentScope(taskId, runId);
    const projected = findTask(await this.tree(root), task.id);
    if (
      projected?.kind !== "local" ||
      !projected.assignedRuns.some((assignment) => assignment.runId === runId)
    ) {
      return;
    }
    await this.store.commit(root, [
      {
        runId,
        type: "task.run.unassigned",
        data: { taskId: task.id, runId },
      },
    ]);
  }

  async appendProgress(taskId: TaskId, message: string): Promise<void> {
    const text = message.trim();
    if (text.length === 0) throw new Error(`Progress message must not be empty`);
    let ownerRunId: RunId;
    if (taskId.startsWith("run:")) {
      ownerRunId = runId(taskId.slice(4));
      this.store.projection.requireRun(ownerRunId);
    } else {
      const task = this.store.projection.localTasks.get(taskId as LocalTaskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      ownerRunId = task.ownerRunId;
    }
    await this.store.commit(this.store.projection.rootOf(ownerRunId), [
      {
        runId: ownerRunId,
        type: "task.progress.appended",
        data: { taskId, message: text },
      },
    ]);
  }

  private assignmentScope(
    taskId: LocalTaskId,
    runId: RunId,
  ): { readonly root: RunId; readonly task: LocalTask } {
    const task = this.store.projection.localTasks.get(taskId);
    if (!task) throw new Error(`Unknown local task: ${taskId}`);
    const run = this.store.projection.requireRun(runId);
    const root = this.store.projection.rootOf(run.id);
    if (this.store.projection.rootOf(task.ownerRunId) !== root) {
      throw new Error(`Task ${taskId} and run ${runId} belong to different roots`);
    }
    return { root, task };
  }
}
