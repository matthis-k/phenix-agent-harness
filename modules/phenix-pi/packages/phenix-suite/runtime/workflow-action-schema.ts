import { type Static, Type } from "typebox";

const WorkflowRequirementsInput = Type.Union([
  Type.Array(Type.String({ minLength: 1 }), {
    maxItems: 64,
    description: "Bounded requirements for the delegated assignment.",
  }),
  Type.String({
    minLength: 1,
    description:
      "One requirement, or a JSON-encoded string array when the model transport cannot preserve arrays.",
  }),
]);

const WorkflowInspectAction = Type.Object(
  {
    action: Type.Literal("inspect", {
      description:
        "Return the current contract-bound workflow authority and the target agents that may be spawned.",
    }),
  },
  { additionalProperties: false },
);

const WorkflowModeInput = Type.Union([Type.Literal("await"), Type.Literal("background")], {
  description:
    "Execution defaults to await so the completed handoff returns through the tool call and the parent session continues. Use background explicitly only when the caller will retain and manage the returned handle.",
});

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
    requirements: Type.Optional(WorkflowRequirementsInput),
    mode: Type.Optional(WorkflowModeInput),
  },
  { additionalProperties: false },
);

export const DirectSubagentParams = Type.Object(
  {
    agent: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "An advertised target agent. May be omitted only when exactly one target is currently legal.",
      }),
    ),
    task: Type.String({
      minLength: 1,
      description: "The bounded objective for the target agent.",
    }),
    requirements: Type.Optional(WorkflowRequirementsInput),
    mode: Type.Optional(WorkflowModeInput),
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
export type DirectSubagentParamsType = Static<typeof DirectSubagentParams>;

/** Normalize arrays and common model-transport string encodings into one stable list. */
export function normalizeWorkflowRequirements(
  value: readonly string[] | string | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;

  const normalize = (items: readonly string[]): string[] => {
    const requirements = items.map((item) => item.trim()).filter((item) => item.length > 0);
    if (requirements.length > 64) {
      throw new TypeError("Workflow requirements may contain at most 64 entries.");
    }
    return requirements.length > 0 ? requirements : [];
  };

  if (typeof value !== "string") return normalize(value);

  const encoded = value.trim();
  if (encoded.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch (error) {
      throw new TypeError(
        `Workflow requirements looked like a JSON array but could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new TypeError("Workflow requirements JSON must be an array of strings.");
    }
    return normalize(parsed);
  }

  return normalize([encoded]);
}
