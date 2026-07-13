import { Type, type Static } from "typebox";

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

const ToolPatchSchema = Type.Optional(
  Type.Union([
    Type.Null(),
    Type.Object(
      {
        additional: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        removed: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      },
      { additionalProperties: false },
    ),
  ]),
);

/** Model-facing parameters for one deterministic workflow transition. */
export const DelegateParams = Type.Object(
  {
    transitionId: Type.String({
      minLength: 1,
      description: "One transition ID from the currently projected Phenix delegation options.",
    }),
    workflowRevision: Type.Integer({
      minimum: 0,
      description: "The exact workflow revision shown with the delegation options.",
    }),
    authorityDigest: Type.String({
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
      description: "The options digest from the current workflow projection.",
    }),
    task: Type.String({
      minLength: 1,
      description: "Task-specific context for the runtime-selected transition and role.",
    }),
    requirements: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
    ),
    tools: ToolPatchSchema,
    delegateRoles: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object(
          {
            additional: Type.Optional(Type.Array(AgentRoleSchema)),
            removed: Type.Optional(Type.Array(AgentRoleSchema)),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("await"), Type.Literal("background")]),
    ),
  },
  { additionalProperties: false },
);

/** Model-facing parameters for persistent handle operations. */
export const AgentParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("await"),
      Type.Literal("poll"),
      Type.Literal("cancel"),
      Type.Literal("inspect"),
      Type.Literal("tree"),
    ]),
    id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export type DelegateParamsType = Static<typeof DelegateParams>;
export type AgentParamsType = Static<typeof AgentParams>;
