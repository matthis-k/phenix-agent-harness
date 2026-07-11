import { Type, type TSchema } from "typebox";

// ── Delegate parameters schema ──────────────────────────────────────────────

export const DelegateParams = Type.Object(
  {
    role: Type.Union([
      Type.Literal("scout"),
      Type.Literal("planner"),
      Type.Literal("architect"),
      Type.Literal("implementer"),
      Type.Literal("tester"),
      Type.Literal("critic"),
      Type.Literal("finalizer"),
      Type.Null(),
    ], {
      description:
        "The subagent role (scout, planner, architect, implementer, tester, critic, finalizer). Null triggers a base agent with no role preset.",
    }),

    task: Type.String({
      minLength: 1,
      description:
        "A bounded objective with context and scope",
    }),

    outputSchema: Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Strict JSON Schema object for the child handoff",
    }),

    requirements: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 64,
        description: "Additional requirements",
      }),
    ),

    tools: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object(
          {
            additional: Type.Optional(
              Type.Array(Type.String({ minLength: 1 })),
            ),
            removed: Type.Optional(
              Type.Array(Type.String({ minLength: 1 })),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
      ]),
    ),

    profile: Type.Optional(
      Type.Object(
        {
          complexity: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
          uncertainty: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
          consequence: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
          breadth: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
          coupling: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
          novelty: Type.Optional(
            Type.Number({ minimum: 0, maximum: 4 }),
          ),
        },
        {
          additionalProperties: false,
        },
      ),
    ),

    mode: Type.Optional(
      Type.Union([
        Type.Literal("await"),
        Type.Literal("background"),
      ]),
    ),

    model: Type.Optional(
      Type.String({ minLength: 1 }),
    ),

    cwd: Type.Optional(
      Type.String({ minLength: 1 }),
    ),

    parent: Type.Optional(
      Type.String({ minLength: 1 }),
    ),
  },
  {
    additionalProperties: false,
  },
);

// ── Agent parameters schema ─────────────────────────────────────────────────

export const AgentParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("await"),
      Type.Literal("poll"),
      Type.Literal("cancel"),
      Type.Literal("inspect"),
      Type.Literal("tree"),
    ]),

    id: Type.Optional(
      Type.String({ minLength: 1 }),
    ),
  },
  {
    additionalProperties: false,
  },
);

// ── Inferred types ──────────────────────────────────────────────────────────

export type DelegateParamsType = typeof DelegateParams extends TSchema
  ? unknown
  : never;

export type AgentParamsType = typeof AgentParams extends TSchema
  ? unknown
  : never;
