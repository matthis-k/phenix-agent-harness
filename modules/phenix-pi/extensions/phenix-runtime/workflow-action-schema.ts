import { type Static, Type } from "typebox";

const WorkflowSpawnInput = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "The bounded objective for the selected spawn edge.",
    }),
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
  },
  { additionalProperties: false },
);

/**
 * Model-facing workflow invocation.
 *
 * The current node and actor authority are derived from the active root session
 * or child contract. The model selects only one advertised edge and supplies
 * the edge-specific input.
 */
export const WorkflowActionParams = Type.Object(
  {
    edgeId: Type.String({
      minLength: 1,
      description: "A legal edge ID from the authority snapshot injected at session start.",
    }),
    spawn: Type.Optional(WorkflowSpawnInput),
  },
  { additionalProperties: false },
);

export type WorkflowActionParamsType = Static<typeof WorkflowActionParams>;
