import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type { ObjectiveNode } from "../domain/objective/projection.ts";
import { type ObjectiveId, objectiveId, type RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import type { AgentToolFactory } from "./agent-tools.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { ObjectiveFacade } from "./interfaces.ts";

const objectiveParameters = defineSchema<{
  action: "tree" | "current" | "add" | "focus" | "set" | "progress";
  objectiveId?: string;
  parentObjectiveId?: string;
  title?: string;
  description?: string;
  state?: "not_started" | "wip" | "done" | "blocked";
  message?: string;
  focus?: boolean;
}>(
  "tool.phenix-objectives",
  Type.Object({
    action: Type.Enum(["tree", "current", "add", "focus", "set", "progress"]),
    objectiveId: Type.Optional(Type.String()),
    parentObjectiveId: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    state: Type.Optional(Type.Enum(["not_started", "wip", "done", "blocked"])),
    message: Type.Optional(Type.String()),
    focus: Type.Optional(Type.Boolean()),
  }),
);

export class ObjectiveAgentToolFactory implements AgentToolFactory {
  private readonly objectives: ObjectiveFacade;
  private readonly store: ExecutionStore;

  constructor(input: { readonly objectives: ObjectiveFacade; readonly store: ExecutionStore }) {
    this.objectives = input.objectives;
    this.store = input.store;
  }

  async forRun(runId: RunId): Promise<readonly AgentTool[]> {
    const tool: AgentTool = {
      name: "phenix_objectives",
      label: "Phenix Objectives",
      description:
        "Manage durable user objectives and discovered sub-objectives. Objectives describe outcomes, not delegations, tool calls, workflow nodes, or other execution steps. Runs inherit their parent run's objective until explicitly focused on a related sub-objective.",
      parameters: objectiveParameters,
      execute: async (raw) => {
        const params = requireValid(raw);
        const rootRunId = this.store.projection.rootOf(runId);
        if (params.action === "tree") return result(await this.objectives.tree(rootRunId));
        const current = await this.objectives.current(runId);
        if (params.action === "current") return result(current ?? { objective: null });
        if (params.action === "add") {
          if (!params.title?.trim()) throw new Error(`add requires title`);
          const run = this.store.projection.requireRun(runId);
          const parentObjectiveId = params.parentObjectiveId
            ? objectiveId(params.parentObjectiveId)
            : run.kind === "root"
              ? undefined
              : current?.id;
          if (run.kind !== "root" && !parentObjectiveId) {
            throw new Error(
              `A child run must already focus an objective before adding a sub-objective`,
            );
          }
          return result(
            await this.objectives.add({
              actorRunId: runId,
              ...(parentObjectiveId ? { parentObjectiveId } : {}),
              title: params.title,
              ...(params.description ? { description: params.description } : {}),
              ...(params.focus !== undefined ? { focus: params.focus } : {}),
            }),
          );
        }
        const targetId = resolveTarget(params.objectiveId, current);
        if (params.action === "focus") {
          return result(await this.objectives.focus(runId, targetId));
        }
        if (params.action === "set") {
          if (!params.state) throw new Error(`set requires state`);
          return result(await this.objectives.setState(runId, targetId, params.state));
        }
        if (!params.message?.trim()) throw new Error(`progress requires message`);
        await this.objectives.appendProgress(runId, targetId, params.message);
        return result({ objectiveId: targetId, appended: true });
      },
    };
    return [tool];
  }
}

export class FilteredAgentToolFactory implements AgentToolFactory {
  private readonly delegate: AgentToolFactory;
  private readonly excluded: ReadonlySet<string>;

  constructor(delegate: AgentToolFactory, excluded: readonly string[]) {
    this.delegate = delegate;
    this.excluded = new Set(excluded);
  }

  async forRun(runId: RunId): Promise<readonly AgentTool[]> {
    return (await this.delegate.forRun(runId)).filter((tool) => !this.excluded.has(tool.name));
  }
}

function resolveTarget(rawId: string | undefined, current: ObjectiveNode | undefined): ObjectiveId {
  if (rawId) return objectiveId(rawId);
  if (current) return current.id;
  throw new Error(`No objectiveId was supplied and this run has no current objective`);
}

function requireValid(value: unknown) {
  const validation = objectiveParameters.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}

function result(value: unknown) {
  return { text: JSON.stringify(value), details: value };
}
