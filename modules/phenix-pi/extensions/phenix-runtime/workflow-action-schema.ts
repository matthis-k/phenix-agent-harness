import { type Static, Type } from "typebox";

const WorkflowInspectAction = Type.Object(
  {
    action: Type.Literal("inspect", {
      description:
        "Return the current contract-bound workflow authority and the target agents that may be spawned.",
    }),
  },
  { additionalProperties: false },
);

const WorkflowSpawnAction = Type.Object(
  {
    action: Type.Literal("spawn", {
      description: "Spawn one target agent permitted by the current contract-bound workflow node.",
    }),
    agent: Type.String({
      minLength: 1,
      description: "A target agent identity advertised in the current workflow authority snapshot.",
    }),
    task: Type.String({
      minLength: 1,
      description: "The bounded objective for the target agent.",
    }),
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
  },
  { additionalProperties: false },
);

/**
 * Model-facing workflow action.
 *
 * The current node and actor authority are derived from the active root session
 * or child contract. The model may inspect that derived authority or state only
 * its spawn intent: one advertised target agent and a bounded assignment.
 */
export const WorkflowActionParams = Type.Union([WorkflowInspectAction, WorkflowSpawnAction]);

export type WorkflowActionParamsType = Static<typeof WorkflowActionParams>;
