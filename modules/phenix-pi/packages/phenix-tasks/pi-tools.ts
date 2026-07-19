import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { PhenixTaskService, TaskAuthority } from "./core.ts";
import { type BoundTaskClient, createInProcessTaskClient } from "./transport.ts";

export const PHENIX_TASKS_TOOL = "phenix_tasks" as const;

const InspectAction = Type.Object(
  {
    action: Type.Literal("inspect"),
  },
  { additionalProperties: false },
);

const AddAction = Type.Object(
  {
    action: Type.Literal("add"),
    parentId: Type.Optional(
      Type.String({ description: "Parent task id. Defaults to the root of the owned subtree." }),
    ),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: false },
);

const UpdateAction = Type.Object(
  {
    action: Type.Literal("update"),
    taskId: Type.String({ minLength: 1 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    description: Type.Optional(Type.String({ maxLength: 4000 })),
    state: Type.Optional(
      Type.Union([Type.Literal("not_started"), Type.Literal("wip"), Type.Literal("done")]),
    ),
  },
  { additionalProperties: false },
);

export const TaskActionParams = Type.Union([InspectAction, AddAction, UpdateAction]);
export type TaskActionParamsType = Static<typeof TaskActionParams>;

export type TaskAuthorityResolver = (ctx: ExtensionContext) => TaskAuthority | string | undefined;
export type TaskClientResolver = (ctx: ExtensionContext) => BoundTaskClient | undefined;
export type TaskToolAuthorizer = (ctx: ExtensionContext) => string | undefined;

function result(payload: unknown): AgentToolResult<Record<string, unknown>> {
  const details = payload as Record<string, unknown>;
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details,
  };
}

function errorResult(message: string): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", message },
  };
}

export function createTaskClientTools(input: {
  readonly resolveClient: TaskClientResolver;
  readonly authorize?: TaskToolAuthorizer;
}): readonly ToolDefinition[] {
  return [
    {
      name: PHENIX_TASKS_TOOL,
      label: "Phenix Tasks",
      description:
        "Inspect and maintain the execution task tree owned by this session. " +
        "Add child tasks before substantial independent steps, mark a task wip when work begins, " +
        "and mark it done immediately after it is completed and verified. The runtime rejects " +
        "changes outside the session-owned subtree.",
      parameters: TaskActionParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const denial = input.authorize?.(ctx);
        if (denial !== undefined) return errorResult(denial);

        const client = input.resolveClient(ctx);
        if (!client) {
          return errorResult("No active Phenix task authority is bound to this session.");
        }

        try {
          const action = params as TaskActionParamsType;
          switch (action.action) {
            case "inspect":
              return result(await client.inspect());
            case "add":
              return result(
                await client.add({
                  ...(action.parentId ? { parentId: action.parentId } : {}),
                  title: action.title,
                  ...(action.description !== undefined ? { description: action.description } : {}),
                }),
              );
            case "update":
              return result(
                await client.update({
                  taskId: action.taskId,
                  ...(action.title !== undefined ? { title: action.title } : {}),
                  ...(action.description !== undefined ? { description: action.description } : {}),
                  ...(action.state !== undefined ? { state: action.state } : {}),
                }),
              );
          }
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }
      },
    } as ToolDefinition,
  ];
}

export function createTaskTools(input: {
  readonly service: PhenixTaskService;
  readonly resolveAuthority: TaskAuthorityResolver;
  readonly authorize?: TaskToolAuthorizer;
}): readonly ToolDefinition[] {
  return createTaskClientTools({
    resolveClient: (ctx) => {
      const resolved = input.resolveAuthority(ctx);
      const authorityToken = typeof resolved === "string" ? resolved : resolved?.token;
      return authorityToken ? createInProcessTaskClient(input.service, authorityToken) : undefined;
    },
    ...(input.authorize ? { authorize: input.authorize } : {}),
  });
}
