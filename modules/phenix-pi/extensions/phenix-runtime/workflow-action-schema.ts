import { type Static, Type } from "typebox";

const WorkflowSpawnAction = Type.Object(
  {
    action: Type.Literal("spawn", {
      description: "Spawn one target agent permitted by the current contract-bound workflow node.",
    }),
    agent: Type.String({
      minLength: 1,
      description:
        "A target agent identity advertised in the authority snapshot injected at session start.",
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
 * or child contract. The model states only its intent: which advertised target
 * agent it wants to spawn and the bounded assignment for that agent.
 */
export const WorkflowActionParams = Type.Union([WorkflowSpawnAction]);

export type WorkflowActionParamsType = Static<typeof WorkflowActionParams>;
