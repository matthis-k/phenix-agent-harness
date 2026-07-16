import { type Static, Type } from "typebox";

const WorkflowInspectAction = Type.Object(
  {
    action: Type.Literal("inspect", {
      description: "Inspect current workflow state and actor-scoped actions.",
    }),
  },
  { additionalProperties: false },
);

const WorkflowDelegateAction = Type.Object(
  {
    action: Type.Literal("delegate", {
      description: "Delegate a bounded task through one currently allowed agent action.",
    }),
    agent: Type.String({
      minLength: 1,
      description:
        "Actor-scoped agent name returned by action=inspect, such as scout or repository-scout.",
    }),
    task: Type.String({
      minLength: 1,
      description: "The bounded objective for the selected workflow action.",
    }),
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
  },
  { additionalProperties: false },
);

/**
 * Stable workflow-tool envelope. New workflow capabilities extend this union
 * with another action instead of introducing unrelated top-level tools.
 */
export const WorkflowActionParams = Type.Union([
  WorkflowInspectAction,
  WorkflowDelegateAction,
]);

export type WorkflowActionParamsType = Static<typeof WorkflowActionParams>;
export type WorkflowDelegateActionType = Static<typeof WorkflowDelegateAction>;
