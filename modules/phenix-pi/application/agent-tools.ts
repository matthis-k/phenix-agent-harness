import { Type } from "typebox";

import { type AnyDefinition, definitionRef } from "../domain/definition/definition.ts";
import { defineSchema, type Schema } from "../domain/definition/schema.ts";
import {
  definitionId,
  localTaskId,
  type Outcome,
  type RunId,
  runId,
  type TaskId,
} from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, ExecutionFacade, TaskFacade } from "./interfaces.ts";
import { allowAllInvocations, type InvocationPolicy } from "./invocation-policy.ts";
import {
  projectCompletedRun,
  projectDispatchResult,
  projectedToolResult,
  projectOutcome,
  projectRetryResult,
  projectRunSnapshot,
  type RunResultView,
} from "./tool-result-projection.ts";

export interface AgentToolFactory {
  forRun(runId: RunId): Promise<readonly AgentTool[]>;
}

const runParameters = defineSchema<{
  definition: string;
  input: unknown;
  wait?: "await" | "background";
}>(
  "tool.phenix-run",
  Type.Object({
    definition: Type.String({ description: "Definition ID from the available Phenix catalog" }),
    input: Type.Unknown({ description: "Input matching the selected definition schema" }),
    wait: Type.Optional(Type.Enum(["await", "background"])),
  }),
);

const dispatchParameters = defineSchema<{
  objective: string;
  context?: unknown;
  mode?: "auto" | "qa" | "implement" | "coordinate";
  wait?: "await" | "background";
}>(
  "tool.phenix-dispatch",
  Type.Object({
    objective: Type.String({ minLength: 1 }),
    context: Type.Optional(Type.Unknown()),
    mode: Type.Optional(Type.Enum(["auto", "qa", "implement", "coordinate"])),
    wait: Type.Optional(Type.Enum(["await", "background"])),
  }),
);

const handleParameters = defineSchema<{
  action: "inspect" | "await" | "send" | "cancel" | "retry";
  runId: string;
  message?: string;
  wait?: "await" | "background";
  view?: RunResultView;
  addTools?: string[];
  limits?: {
    timeoutMs?: number;
    maxTurns?: number | null;
    maxToolCalls?: number | null;
    maxRepairAttempts?: number;
  };
}>(
  "tool.phenix-handle",
  Type.Object({
    action: Type.Enum(["inspect", "await", "send", "cancel", "retry"]),
    runId: Type.String(),
    message: Type.Optional(Type.String()),
    wait: Type.Optional(Type.Enum(["await", "background"])),
    view: Type.Optional(Type.Enum(["summary", "outcome", "failure", "full"])),
    addTools: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
    limits: Type.Optional(
      Type.Object({
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
        maxTurns: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 200 }), Type.Null()]),
        ),
        maxToolCalls: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Null()]),
        ),
        maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      }),
    ),
  }),
);

const taskParameters = defineSchema<{
  action: "tree" | "list" | "add" | "set" | "progress";
  taskId?: string;
  title?: string;
  description?: string;
  state?: "not_started" | "wip" | "done" | "failed";
  message?: string;
}>(
  "tool.phenix-tasks",
  Type.Object({
    action: Type.Enum(["tree", "list", "add", "set", "progress"]),
    taskId: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    state: Type.Optional(Type.Enum(["not_started", "wip", "done", "failed"])),
    message: Type.Optional(Type.String()),
  }),
);

export class FacadeAgentToolFactory implements AgentToolFactory {
  private readonly execution: ExecutionFacade;
  private readonly dispatch?: DispatchService;
  private readonly tasks: TaskFacade;
  private readonly catalog: CatalogFacade;
  private readonly store: ExecutionStore;
  private readonly invocationPolicy: InvocationPolicy;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly dispatch?: DispatchService;
    readonly tasks: TaskFacade;
    readonly catalog: CatalogFacade;
    readonly store: ExecutionStore;
    readonly invocationPolicy?: InvocationPolicy;
  }) {
    this.execution = input.execution;
    this.dispatch = input.dispatch;
    this.tasks = input.tasks;
    this.catalog = input.catalog;
    this.store = input.store;
    this.invocationPolicy = input.invocationPolicy ?? allowAllInvocations;
  }

  async forRun(parentId: RunId): Promise<readonly AgentTool[]> {
    const parent = this.store.projection.requireRun(parentId);
    const available = await this.catalog.listAvailable(parentId);
    const runTool: AgentTool = {
      name: "phenix_run",
      label: "Phenix Run",
      description: `Invoke one typed agent or workflow definition. Available: ${
        available.map((definition) => definition.id).join(", ") || "none"
      }. Awaited calls return a compact summary and run ID; inspect the handle with view=outcome only when the complete typed result is needed.`,
      parameters: runParameters,
      execute: async (raw, signal) => {
        const params = requireValid(runParameters, raw);
        const ref = definitionRef(definitionId(params.definition));
        const currentParent = this.store.projection.requireRun(parentId);
        this.invocationPolicy.assertAllowed({
          rootRunId: this.store.projection.rootOf(parentId),
          parent: currentParent,
          definition: this.catalog.get(ref) as AnyDefinition,
          input: params.input,
        });
        const handle = await this.execution.start({
          parentId,
          definition: ref,
          input: params.input,
          wait: params.wait ?? "await",
        });
        if ((params.wait ?? "await") === "background") {
          return projectedToolResult({ runId: handle.id, status: "running" });
        }
        const outcome = await handle.result(signal);
        return projectedToolResult(projectCompletedRun(handle.id, outcome), outcome);
      },
    };

    const dispatchTool: AgentTool = {
      name: "phenix_dispatch",
      label: "Phenix Dispatch",
      description:
        "Route substantial work through a mandatory catalog-driven selector. Use auto for normal requests; explicit qa, implement, or coordinate modes are operator overrides only. Completed dispatches return a compact run summary; retrieve the full typed outcome explicitly through phenix_handle when needed.",
      parameters: dispatchParameters,
      execute: async (raw, signal) => {
        const params = requireValid(dispatchParameters, raw);
        if (!this.dispatch) throw new Error("Root dispatch service is not configured");
        const result = await this.dispatch.dispatch(parentId, params, signal);
        return projectedToolResult(projectDispatchResult(result), result);
      },
    };

    const handleTool: AgentTool = {
      name: "phenix_handle",
      label: "Phenix Handle",
      description:
        "Inspect, await, message, cancel, or retry an accessible run. Summary is the default low-context view; request view=outcome, failure, or full only when that data is required. Retry creates a linked replacement run and may explicitly add bounded read/search or bash execution permissions.",
      parameters: handleParameters,
      execute: async (raw, signal) => {
        const params = requireValid(handleParameters, raw);
        const targetId = runId(params.runId);
        this.assertAccessible(parentId, targetId);
        if (targetId === parentId && params.action !== "inspect") {
          throw new Error(`A run cannot control its own lifecycle through phenix_handle`);
        }
        if (params.action === "inspect") {
          const snapshot = await this.execution.inspect(targetId);
          return projectedToolResult(projectRunSnapshot(snapshot, params.view), snapshot);
        }
        if (params.action === "await") {
          const outcome = await this.execution.await(targetId, signal);
          return projectedToolResult(projectOutcomeForView(outcome, params.view), outcome);
        }
        if (params.action === "retry") {
          const wait = params.wait ?? "await";
          const handle = await this.execution.retry(parentId, targetId, {
            wait,
            ...(params.addTools ? { addTools: params.addTools } : {}),
            ...(params.limits ? { limits: params.limits } : {}),
          });
          if (wait === "background") {
            return projectedToolResult({ runId: handle.id, retryOf: targetId, status: "running" });
          }
          const outcome = await handle.result(signal);
          const projected =
            params.view === "outcome" || params.view === "full"
              ? { runId: handle.id, retryOf: targetId, outcome }
              : params.view === "failure" && outcome.status === "failure"
                ? { runId: handle.id, retryOf: targetId, failure: outcome.failure }
                : projectRetryResult(handle.id, targetId, outcome);
          return projectedToolResult(projected, { runId: handle.id, retryOf: targetId, outcome });
        }
        const caller = this.store.projection.requireRun(parentId);
        if (params.action === "send") {
          if (!caller.compiled.capabilities.maySend) {
            throw new Error(`Run ${parentId} may not send child messages`);
          }
          if (!params.message?.trim()) throw new Error(`send requires message`);
          await this.execution.send(targetId, params.message, signal);
          return { text: `Message sent to ${targetId}.` };
        }
        if (!caller.compiled.capabilities.mayCancelChildren) {
          throw new Error(`Run ${parentId} may not cancel children`);
        }
        await this.execution.cancel(
          targetId,
          params.message?.trim() || "Cancelled by parent agent",
        );
        return { text: `Cancellation requested for ${targetId}.` };
      },
    };

    const taskTool: AgentTool = {
      name: "phenix_tasks",
      label: "Phenix Tasks",
      description:
        "Read the derived task tree or manage local task leaves owned by this run. Execution task anchors are read-only.",
      parameters: taskParameters,
      execute: async (raw) => {
        const params = requireValid(taskParameters, raw);
        const root = this.store.projection.rootOf(parentId);
        if (params.action === "tree") {
          const tree = await this.tasks.tree(root);
          return { text: JSON.stringify(tree), details: tree };
        }
        if (params.action === "list") {
          const tasks = await this.tasks.tasksFor(parentId);
          return { text: JSON.stringify(tasks), details: tasks };
        }
        if (params.action === "add") {
          if (!params.title?.trim()) throw new Error(`add requires title`);
          const task = await this.tasks.addLocal({
            ownerRunId: parentId,
            title: params.title,
            ...(params.description ? { description: params.description } : {}),
          });
          return { text: JSON.stringify(task), details: task };
        }
        if (!params.taskId) throw new Error(`${params.action} requires taskId`);
        const task = this.store.projection.localTasks.get(localTaskId(params.taskId));
        if (task && task.ownerRunId !== parentId) {
          throw new Error(`Agents may mutate only their own local task leaves`);
        }
        if (params.action === "progress" && !task && params.taskId !== `run:${parentId}`) {
          throw new Error(`Agents may append progress only to their own execution anchor`);
        }
        if (params.action === "set") {
          if (!params.state) throw new Error(`set requires state`);
          const updated = await this.tasks.setLocalState(localTaskId(params.taskId), params.state);
          return { text: JSON.stringify(updated), details: updated };
        }
        if (!params.message?.trim()) throw new Error(`progress requires message`);
        await this.tasks.appendProgress(params.taskId as TaskId, params.message);
        return { text: `Progress appended to ${params.taskId}.` };
      },
    };

    return parent.kind === "root"
      ? [dispatchTool, handleTool, taskTool]
      : [runTool, handleTool, taskTool];
  }

  private assertAccessible(callerId: RunId, targetId: RunId): void {
    const caller = this.store.projection.requireRun(callerId);
    let target = this.store.projection.requireRun(targetId);
    if (caller.kind === "root" && this.store.projection.rootOf(target.id) === caller.id) return;
    while (target.parentId) {
      if (target.parentId === caller.id) return;
      target = this.store.projection.requireRun(target.parentId);
    }
    throw new Error(`Run ${targetId} is outside caller ${callerId}'s task scope`);
  }
}

function projectOutcomeForView(
  outcome: Outcome<unknown>,
  view: RunResultView | undefined,
): unknown {
  if (view === "outcome" || view === "full") return outcome;
  return projectOutcome(outcome, view ?? "summary");
}

function requireValid<T>(schema: Schema<T>, value: unknown): T {
  const validation = schema.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}
