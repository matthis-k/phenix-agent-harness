import { type Static, Type } from "typebox";

const InternalSpawnFields = {
  transitionId: Type.String({
    minLength: 1,
    description: "Internal workflow edge identity selected by the workflow runtime.",
  }),
  task: Type.String({
    minLength: 1,
    description: "The bounded objective for the selected workflow edge.",
  }),
  requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
  mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
  /** Migration-only fields. Workflow execution never permits model-supplied patches. */
  tools: Type.Optional(Type.Null()),
  delegateRoles: Type.Optional(Type.Null()),
} as const;

/** Internal execution parameters after fresh node and edge authority is bound. */
export const DelegateParams = Type.Object(
  {
    ...InternalSpawnFields,
    workflowRevision: Type.Integer({ minimum: 0 }),
    authorityDigest: Type.String({
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
    }),
  },
  { additionalProperties: false },
);

/** Model-facing parameters for one persistent handle operation. */
export const AgentParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal("await"),
      Type.Literal("poll"),
      Type.Literal("cancel"),
      Type.Literal("inspect"),
    ]),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type DelegateParamsType = Static<typeof DelegateParams>;
export type AgentParamsType = Static<typeof AgentParams>;
