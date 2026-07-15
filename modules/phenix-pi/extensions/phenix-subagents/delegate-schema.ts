import { type Static, Type } from "typebox";

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

const DelegateRolePatchSchema = Type.Optional(
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
);

const WorkflowCreationFields = {
  transitionId: Type.String({
    minLength: 1,
    description:
      "One transition ID returned by phenix_workflow. The runtime resolves the role, model, thinking level, output schema, and verification policy.",
  }),
  task: Type.String({
    minLength: 1,
    description: "The bounded objective for the selected workflow transition.",
  }),
  requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
  tools: ToolPatchSchema,
  delegateRoles: DelegateRolePatchSchema,
  mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
} as const;

/** Query the exact current workflow and contract-derived creation authority. */
export const WorkflowInspectParams = Type.Object({}, { additionalProperties: false });

/** Model-facing creation parameters. Workflow authority metadata is runtime-injected. */
export const WorkflowCreateParams = Type.Object(WorkflowCreationFields, {
  additionalProperties: false,
});

/** Internal execution parameters after the workflow API binds fresh authority. */
export const DelegateParams = Type.Object(
  {
    ...WorkflowCreationFields,
    workflowRevision: Type.Integer({ minimum: 0 }),
    authorityDigest: Type.String({
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
    }),
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

export type WorkflowCreateParamsType = Static<typeof WorkflowCreateParams>;
export type DelegateParamsType = Static<typeof DelegateParams>;
export type AgentParamsType = Static<typeof AgentParams>;
