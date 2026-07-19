import { createHash } from "node:crypto";
import type { Difficulty } from "@matthis-k/phenix-kernel/task.ts";
import { resolveDelegationOptions } from "./delegation-options.ts";
import { delegateTransitionById, targetAgentForTransition } from "./workflow-target-agents.ts";
import type {
  DelegationAuthority,
  DelegationOption,
  WorkflowDefinition,
  WorkflowHandleRecord,
  WorkflowOutputSchemaId,
  WorkflowRuntimeRecord,
} from "./workflow-types.ts";

/** Internal authority projection used to bind model intent to one transition. */
export interface ModelDelegationOption {
  readonly agent: string;
  /** Private runtime identity; never required from the model. */
  readonly transitionId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly workflowRevision: number;
  readonly role: string;
  readonly purpose: string;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";
  readonly outputSchemaId: WorkflowOutputSchemaId;
  readonly allowedModes: ReadonlyArray<"await" | "background">;
  readonly resultSchema: Record<string, unknown>;
}

export interface ModelWorkflowProjection {
  readonly difficulty: Difficulty;
  readonly currentState: string;
  readonly revision: number;
  readonly optionsDigest: string;
  readonly options: readonly ModelDelegationOption[];
}

export interface WorkflowDecisionContext extends ModelWorkflowProjection {}

export interface WorkflowProjectionPromptOptions {
  readonly completion: "direct" | "phenix_complete";
}

export function projectDelegationOptions(
  definition: WorkflowDefinition,
  sourceNodeId: string,
  options: readonly DelegationOption[],
): readonly ModelDelegationOption[] {
  return options.map((option) => {
    const transition = delegateTransitionById(definition, option.transitionId);
    if (!transition) {
      throw new Error(
        `Workflow transition "${option.transitionId}" is missing or is not a delegate transition`,
      );
    }

    return {
      agent: targetAgentForTransition(transition),
      transitionId: option.transitionId,
      sourceNodeId,
      targetNodeId: option.targetState,
      workflowRevision: option.workflowRevision,
      role: option.role ?? "base",
      purpose: option.purpose,
      description: option.description,
      category: option.category,
      outputSchemaId: option.outputSchemaId,
      allowedModes: [...option.allowedModes],
      resultSchema: option.outputSchema,
    };
  });
}

export function computeOptionsDigest(options: readonly ModelDelegationOption[]): string {
  const canonical = [...options]
    .sort((left, right) => left.agent.localeCompare(right.agent))
    .map((option) => ({
      agent: option.agent,
      transitionId: option.transitionId,
      sourceNodeId: option.sourceNodeId,
      targetNodeId: option.targetNodeId,
      workflowRevision: option.workflowRevision,
      role: option.role,
      allowedModes: [...(option.allowedModes ?? [])].sort(),
      outputSchemaId: option.outputSchemaId,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function buildWorkflowDecisionContext(input: {
  readonly definition: WorkflowDefinition;
  readonly runtime: WorkflowRuntimeRecord;
  readonly authority: DelegationAuthority;
  readonly activeHandles: readonly WorkflowHandleRecord[];
}): WorkflowDecisionContext {
  const options = projectDelegationOptions(
    input.definition,
    input.runtime.state,
    resolveDelegationOptions(input),
  );
  return {
    difficulty: input.runtime.difficulty,
    currentState: input.runtime.state,
    revision: input.runtime.revision,
    optionsDigest: computeOptionsDigest(options),
    options,
  };
}

export function buildRootWorkflowProjection(
  input: Parameters<typeof buildWorkflowDecisionContext>[0],
): ModelWorkflowProjection {
  return buildWorkflowDecisionContext(input);
}

export function buildChildWorkflowProjection(
  input: Parameters<typeof buildWorkflowDecisionContext>[0],
): ModelWorkflowProjection {
  return buildWorkflowDecisionContext(input);
}

/** Format the authority snapshot that is deterministically injected before inference. */
export function formatWorkflowProjection(
  projection: ModelWorkflowProjection,
  options: WorkflowProjectionPromptOptions = { completion: "direct" },
): string {
  const lines = [
    "## Phenix workflow authority",
    "",
    "This authority snapshot was resolved by the runtime before this agent started.",
    "The active session or contract owns the current node; never send a node ID back to the runtime.",
    `Current node: ${projection.currentState}`,
    `Difficulty: ${projection.difficulty}`,
    "",
  ];

  if (projection.options.length === 0) {
    lines.push(
      "The current contract-bound node permits no target agent to be spawned.",
      options.completion === "phenix_complete"
        ? "Complete the current assignment directly using phenix_complete."
        : "Complete the current assignment directly without creating a subagent.",
      "",
    );
    return lines.join("\n");
  }

  lines.push(
    "Target agents available from the current workflow node:",
    "Use them when delegation would materially improve evidence, planning, implementation, testing, or review.",
    "",
  );
  for (const [index, option] of projection.options.entries()) {
    lines.push(
      `${index + 1}. Agent: ${option.agent}`,
      `   Execution role: ${option.role}`,
      `   Category: ${option.category}`,
      `   Purpose: ${option.description}`,
      `   Result schema: ${option.outputSchemaId}`,
      `   Modes: ${option.allowedModes.join(", ")}`,
      "",
    );
  }

  lines.push(
    "Workflow invocation protocol:",
    "- The preloaded snapshot is the initial authority inspection; do not call a separate discovery mechanism before the first workflow action.",
    "- Call phenix_workflow with action=inspect after a workflow action may have changed the current node or legal target set.",
    "- Call phenix_workflow with action=spawn, one currently advertised agent, and its bounded task input.",
    "- The runtime derives the current node and resolves that target agent to the unique legal transition.",
    "- Do not invent a transition ID, role, result schema, model, thinking level, tool set, delegation depth, or node ID.",
  );
  return lines.join("\n");
}
