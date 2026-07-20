import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { TaskAuthority, TaskRuntimeFacade } from "./facade.ts";
import { type BoundTaskClient, createInProcessTaskClient } from "./transport.ts";

export const PHENIX_TASKS_TOOL = "phenix_tasks" as const;

const InspectAction = Type.Object(
  { action: Type.Literal("inspect") },
  { additionalProperties: false },
);
const AddAction = Type.Object(
  {
    action: Type.Literal("add"),
    parentUid: Type.Optional(
      Type.String({ description: "Parent task UID; defaults to owned root." }),
    ),
    name: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.Optional(Type.String({ maxLength: 240 })),
  },
  { additionalProperties: false },
);
const UpdateAction = Type.Object(
  {
    action: Type.Literal("update"),
    uid: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    description: Type.Optional(Type.String({ maxLength: 240 })),
    status: Type.Optional(
      Type.Union([Type.Literal("not_started"), Type.Literal("wip"), Type.Literal("done")]),
    ),
  },
  { additionalProperties: false },
);
const LogAction = Type.Object(
  {
    action: Type.Literal("log"),
    uid: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);

export const TaskActionParams = Type.Union([InspectAction, AddAction, UpdateAction, LogAction]);
export type TaskActionParamsType = Static<typeof TaskActionParams>;
export type TaskAuthorityResolver = (ctx: ExtensionContext) => TaskAuthority | string | undefined;
export type TaskClientResolver = (ctx: ExtensionContext) => BoundTaskClient | undefined;
export type TaskToolAuthorizer = (ctx: ExtensionContext) => string | undefined;

function result(payload: unknown): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload as Record<string, unknown>,
  };
}

function fail(message: string): never {
  const error = new Error(message) as Error & { details?: Record<string, unknown> };
  error.details = { status: "failed", message };
  throw error;
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
        "Maintain the owned execution task tree. Tasks have a short name and description; " +
        "append concise process updates with action=log instead of creating narrative tasks. " +
        "The runtime enforces subtree ownership and append-only logs.",
      parameters: TaskActionParams,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const denial = input.authorize?.(ctx);
        if (denial !== undefined) return fail(denial);
        const client = input.resolveClient(ctx);
        if (!client) return fail("No active Phenix task authority is bound to this session.");

        const action = params as TaskActionParamsType;
        try {
          switch (action.action) {
            case "inspect":
              return result(await client.inspect());
            case "add":
              return result(
                await client.add({
                  ...(action.parentUid ? { parentUid: action.parentUid } : {}),
                  name: action.name,
                  ...(action.description !== undefined ? { description: action.description } : {}),
                }),
              );
            case "update":
              return result(
                await client.update({
                  uid: action.uid,
                  ...(action.name !== undefined ? { name: action.name } : {}),
                  ...(action.description !== undefined ? { description: action.description } : {}),
                  ...(action.status !== undefined ? { status: action.status } : {}),
                }),
              );
            case "log":
              return result(await client.appendLog({ uid: action.uid, message: action.message }));
          }
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    } as ToolDefinition,
  ];
}

export function createTaskTools(input: {
  readonly service: TaskRuntimeFacade;
  readonly resolveAuthority: TaskAuthorityResolver;
  readonly authorize?: TaskToolAuthorizer;
}): readonly ToolDefinition[] {
  return createTaskClientTools({
    resolveClient: (ctx) => {
      const resolved = input.resolveAuthority(ctx);
      const token = typeof resolved === "string" ? resolved : resolved?.token;
      return token ? createInProcessTaskClient(input.service, token) : undefined;
    },
    ...(input.authorize ? { authorize: input.authorize } : {}),
  });
}
