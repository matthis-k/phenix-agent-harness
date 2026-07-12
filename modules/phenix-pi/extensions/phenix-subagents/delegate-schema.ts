import { Type, type TSchema } from "typebox";

// ── Agent role schema ───────────────────────────────────────────────────────

const AgentRoleSchema = Type.Union([
  Type.Literal("scout"),
  Type.Literal("planner"),
  Type.Literal("architect"),
  Type.Literal("implementer"),
  Type.Literal("tester"),
  Type.Literal("critic"),
  Type.Literal("finalizer"),
  Type.Null(),
]);

// ── Tool patch schema ───────────────────────────────────────────────────────

const ToolPatchSchema = Type.Optional(
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
);

// ── Delegate parameters schema (v4) ─────────────────────────────────────────

export const DelegateParams = Type.Object(
  {
    transitionId: Type.String({
      minLength: 1,
      description:
        "One transition ID from the currently projected Phenix delegation options.",
    }),

    workflowRevision: Type.Integer({
      minimum: 0,
      description:
        "The exact workflow revision shown with the delegation options.",
    }),

    task: Type.String({
      minLength: 1,
      description:
        "Task-specific context for the runtime-selected transition and role.",
    }),

    requirements: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        maxItems: 64,
      }),
    ),

    tools: ToolPatchSchema,

    delegateRoles: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object(
          {
            additional: Type.Optional(
              Type.Array(AgentRoleSchema),
            ),
            removed: Type.Optional(
              Type.Array(AgentRoleSchema),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
      ]),
    ),

    mode: Type.Optional(
      Type.Union([
        Type.Literal("await"),
        Type.Literal("background"),
      ]),
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
