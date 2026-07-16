import { type Static, Type } from "typebox";

const WorkflowInspectAction = Type.Object(
  {
    action: Type.Literal("inspect", {
      description: "Return the current workflow node and legal outgoing edges.",
    }),
  },
  { additionalProperties: false },
);

const WorkflowSpawnInput = Type.Object(
  {
    task: Type.String({
      minLength: 1,
      description: "The bounded objective for a spawn edge.",
    }),
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),
  },
  { additionalProperties: false },
);

const WorkflowTakeEdgeAction = Type.Object(
  {
    action: Type.Literal("take", {
      description: "Take one legal outgoing edge from the expected current node.",
    }),
    nodeId: Type.String({
      minLength: 1,
      description: "Current node ID returned by action=inspect.",
    }),
    edgeId: Type.String({
      minLength: 1,
      description: "Outgoing edge ID returned by action=inspect.",
    }),
    spawn: Type.Optional(WorkflowSpawnInput),
  },
  { additionalProperties: false },
);

/**
 * Stable graph-facing workflow envelope. Future workflow behavior adds edge
 * kinds behind `take`; it does not require a new top-level tool or expose the
 * generic child-session runtime.
 */
export const WorkflowActionParams = Type.Union([WorkflowInspectAction, WorkflowTakeEdgeAction]);

export type WorkflowActionParamsType = Static<typeof WorkflowActionParams>;
export type WorkflowTakeEdgeActionType = Static<typeof WorkflowTakeEdgeAction>;
