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
    const tree = await this.tree(root);
    const task = findTask(tree, `run:${runId}`);
    return task?.kind === "execution" ? task.children : [];
  }

  async addLocal(input: {
    readonly ownerRunId: RunId;
    readonly title: string;
    readonly description?: string;
  }): Promise<LocalTask> {
    const title = input.title.trim();
    if (title.length === 0) throw new Error(`Local task title must not be empty`);
    const owner = this.store.projection.requireRun(input.ownerRunId);
    const now = this.clock.now();
    const task: LocalTask = {
      kind: "local",
      id: localTaskId(this.ids.next("task")),
      ownerRunId: owner.id,
      title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      state: "not_started",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.commit(this.store.projection.rootOf(owner.id), [
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
}
