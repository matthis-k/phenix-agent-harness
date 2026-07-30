import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import {
  decisionId,
  interventionId,
  type ProjectActor,
  type ProjectDecisionInput,
  type ProjectDestination,
  projectId,
} from "../domain/project/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool, AgentToolResult } from "../ports/agent-session-backend.ts";
import type { AgentToolFactory } from "./agent-tools.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type {
  CreateProjectRequest,
  ProjectPlannerFacade,
  RequestProjectInput,
  ResolveDecisionRequest,
} from "./project-planner.ts";

const projectParameters = defineSchema<{
  action:
    | "list"
    | "create"
    | "inspect"
    | "frontier"
    | "add_decision"
    | "update_fog"
    | "claim"
    | "release"
    | "resolve"
    | "out_of_scope"
    | "request_input"
    | "answer_input"
    | "publish"
    | "export_spec";
  projectId?: string;
  decisionId?: string;
  interventionId?: string;
  title?: string;
  destination?: {
    outcome: string;
    useCase: string;
    doneWhen: string[];
    nonGoals: string[];
  };
  notes?: string[];
  fog?: string[];
  decisions?: Array<{
    id?: string;
    title: string;
    question: string;
    type: "research" | "prototype" | "grilling" | "task";
    mode: "afk" | "hitl";
    dependsOn?: string[];
  }>;
  decision?: {
    id?: string;
    title: string;
    question: string;
    type: "research" | "prototype" | "grilling" | "task";
    mode: "afk" | "hitl";
    dependsOn?: string[];
  };
  summary?: string;
  rationale?: string;
  evidence?: string[];
  consequences?: string[];
  reason?: string;
  question?: string;
  context?: string;
  options?: string[];
  answer?: string;
}>(
  "tool.phenix-project",
  Type.Object({
    action: Type.Enum([
      "list",
      "create",
      "inspect",
      "frontier",
      "add_decision",
      "update_fog",
      "claim",
      "release",
      "resolve",
      "out_of_scope",
      "request_input",
      "answer_input",
      "publish",
      "export_spec",
    ]),
    projectId: Type.Optional(Type.String()),
    decisionId: Type.Optional(Type.String()),
    interventionId: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    destination: Type.Optional(
      Type.Object({
        outcome: Type.String(),
        useCase: Type.String(),
        doneWhen: Type.Array(Type.String()),
        nonGoals: Type.Array(Type.String()),
      }),
    ),
    notes: Type.Optional(Type.Array(Type.String())),
    fog: Type.Optional(Type.Array(Type.String())),
    decisions: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          title: Type.String(),
          question: Type.String(),
          type: Type.Enum(["research", "prototype", "grilling", "task"]),
          mode: Type.Enum(["afk", "hitl"]),
          dependsOn: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    ),
    decision: Type.Optional(
      Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.String(),
        question: Type.String(),
        type: Type.Enum(["research", "prototype", "grilling", "task"]),
        mode: Type.Enum(["afk", "hitl"]),
        dependsOn: Type.Optional(Type.Array(Type.String())),
      }),
    ),
    summary: Type.Optional(Type.String()),
    rationale: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Type.String())),
    consequences: Type.Optional(Type.Array(Type.String())),
    reason: Type.Optional(Type.String()),
    question: Type.Optional(Type.String()),
    context: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(Type.String())),
    answer: Type.Optional(Type.String()),
  }),
);

export class ProjectAgentToolFactory implements AgentToolFactory {
  private readonly projects: ProjectPlannerFacade;
  private readonly store: ExecutionStore;

  constructor(projects: ProjectPlannerFacade, store: ExecutionStore) {
    this.projects = projects;
    this.store = store;
  }

  async forRun(parentId: RunId): Promise<readonly AgentTool[]> {
    const parent = this.store.projection.requireRun(parentId);
    const actor = actorFor(this.store, parentId);
    const tool: AgentTool = {
      name: "phenix_project",
      label: "Phenix Project",
      description:
        "Plan and execute work that spans multiple independent sessions. First pin the destination, use case, completion criteria, and non-goals; then chart decision tickets breadth-first. The project ledger is durable across sessions. Use request_input from a claimed decision to focus the user without inheriting the root conversation. GitHub publication creates a map issue, native sub-issues, and native blocked-by edges.",
      parameters: projectParameters,
      execute: async (raw) => {
        const params = requireValid(raw);
        if (
          ["create", "publish", "answer_input"].includes(params.action) &&
          parent.kind !== "root"
        ) {
          throw new Error(`${params.action} is reserved for the root project supervisor`);
        }
        switch (params.action) {
          case "list":
            return result(await this.projects.list());
          case "create":
            return result(await this.projects.create(createRequest(params), actor));
          case "inspect":
            return result(await this.projects.inspect(requireProjectId(params.projectId)));
          case "frontier":
            return result(await this.projects.frontier(requireProjectId(params.projectId)));
          case "add_decision":
            return result(
              await this.projects.addDecision(
                requireProjectId(params.projectId),
                decisionInput(requireField("decision", params.decision)),
                actor,
              ),
            );
          case "update_fog":
            return result(
              await this.projects.updateFog(
                requireProjectId(params.projectId),
                requireField("fog", params.fog),
                actor,
              ),
            );
          case "claim":
            return result(
              await this.projects.claim(
                requireProjectId(params.projectId),
                requireDecisionId(params.decisionId),
                actor,
              ),
            );
          case "release":
            return result(
              await this.projects.release(
                requireProjectId(params.projectId),
                requireDecisionId(params.decisionId),
                actor,
              ),
            );
          case "resolve":
            return result(
              await this.projects.resolve(
                requireProjectId(params.projectId),
                requireDecisionId(params.decisionId),
                resolutionRequest(params),
                actor,
              ),
            );
          case "out_of_scope":
            return result(
              await this.projects.markOutOfScope(
                requireProjectId(params.projectId),
                requireDecisionId(params.decisionId),
                requireField("reason", params.reason),
                actor,
              ),
            );
          case "request_input":
            return result(
              await this.projects.requestInput(
                requireProjectId(params.projectId),
                requireDecisionId(params.decisionId),
                inputRequest(params),
                actor,
              ),
            );
          case "answer_input":
            return result(
              await this.projects.answerInput(
                requireProjectId(params.projectId),
                interventionId(requireField("interventionId", params.interventionId)),
                requireField("answer", params.answer),
                actor,
              ),
            );
          case "publish":
            return result(await this.projects.publish(requireProjectId(params.projectId), actor));
          case "export_spec": {
            const text = await this.projects.exportSpec(requireProjectId(params.projectId));
            return { text, details: { projectId: params.projectId, format: "markdown" } };
          }
        }
      },
    };
    return [tool];
  }
}

export class CompositeAgentToolFactory implements AgentToolFactory {
  private readonly factories: readonly AgentToolFactory[];

  constructor(factories: readonly AgentToolFactory[]) {
    this.factories = factories;
  }

  async forRun(runId: RunId): Promise<readonly AgentTool[]> {
    return (await Promise.all(this.factories.map((factory) => factory.forRun(runId)))).flat();
  }
}

function createRequest(params: ReturnType<typeof requireValid>): CreateProjectRequest {
  const title = requireField("title", params.title);
  const destination = requireField("destination", params.destination) as ProjectDestination;
  return {
    title,
    destination,
    ...(params.notes ? { notes: params.notes } : {}),
    ...(params.fog ? { fog: params.fog } : {}),
    ...(params.decisions ? { decisions: params.decisions.map(decisionInput) } : {}),
  };
}

function decisionInput(
  input: NonNullable<ReturnType<typeof requireValid>["decision"]>,
): ProjectDecisionInput {
  return {
    ...(input.id ? { id: decisionId(input.id) } : {}),
    title: input.title,
    question: input.question,
    type: input.type,
    mode: input.mode,
    ...(input.dependsOn ? { dependsOn: input.dependsOn.map(decisionId) } : {}),
  };
}

function resolutionRequest(params: ReturnType<typeof requireValid>): ResolveDecisionRequest {
  return {
    summary: requireField("summary", params.summary),
    rationale: requireField("rationale", params.rationale),
    ...(params.evidence ? { evidence: params.evidence } : {}),
    ...(params.consequences ? { consequences: params.consequences } : {}),
  };
}

function inputRequest(params: ReturnType<typeof requireValid>): RequestProjectInput {
  return {
    question: requireField("question", params.question),
    ...(params.context ? { context: params.context } : {}),
    ...(params.options ? { options: params.options } : {}),
  };
}

function actorFor(store: ExecutionStore, runId: RunId): ProjectActor {
  const run = store.projection.requireRun(runId);
  return {
    rootRunId: store.projection.rootOf(runId),
    runId,
    ...(run.pi?.sessionId ? { sessionId: run.pi.sessionId } : {}),
  };
}

function requireProjectId(value: string | undefined) {
  return projectId(requireField("projectId", value));
}

function requireDecisionId(value: string | undefined) {
  return decisionId(requireField("decisionId", value));
}

function requireField<T>(name: string, value: T | undefined): T {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function requireValid(value: unknown) {
  const validation = projectParameters.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}

function result(value: unknown): AgentToolResult {
  return { text: JSON.stringify(value), details: value };
}
