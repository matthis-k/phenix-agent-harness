import type {
  WorkflowAuthoritySnapshot,
  WorkflowSpawnRequest,
} from "../runtime/workflow-runtime-types.ts";

export interface WorkflowAssignmentInput {
  readonly source: "root" | "contract";
  readonly category: "required" | "optional" | "repair";
  readonly transitionDescription: string;
  readonly requestedTask: string;
  readonly userTask?: string;
  readonly requestedRequirements?: readonly string[];
}

export interface ResolvedWorkflowAssignment {
  readonly task: string;
  readonly requirements: readonly string[];
}

function uniqueRequirements(requirements: readonly string[]): readonly string[] {
  return [...new Set(requirements.map((item) => item.trim()).filter(Boolean))];
}

export function resolveWorkflowAssignment(
  input: WorkflowAssignmentInput,
): ResolvedWorkflowAssignment {
  const requestedRequirements = input.requestedRequirements ?? [];
  const userTask = input.userTask?.trim();
  const isRequiredRoot = input.source === "root" && input.category === "required" && Boolean(userTask);

  if (!isRequiredRoot || !userTask) {
    return {
      task: input.requestedTask,
      requirements: uniqueRequirements(requestedRequirements),
    };
  }

  return {
    task: `${input.transitionDescription}\n\nComplete the full user request:\n${userTask}`,
    requirements: uniqueRequirements([
      ...requestedRequirements,
      "Complete the entire user request, not only setup, discovery, or one intermediate command.",
      "Follow the applicable repository instructions and skills, and return the complete contract result.",
    ]),
  };
}

/**
 * Resolve the immutable assignment used by task preparation and child contracts.
 *
 * Required root assignments are canonicalized from workflow authority and the
 * original user request. Other assignments retain the model-supplied bounded
 * task. Returning the original request when no unique target is available lets
 * the workflow runtime report the authoritative transition error.
 */
export function resolveWorkflowSpawnRequest(
  snapshot: WorkflowAuthoritySnapshot,
  request: WorkflowSpawnRequest,
): WorkflowSpawnRequest {
  const matches = snapshot.workflow.options.filter((option) => option.agent === request.agent);
  if (matches.length !== 1) return request;

  const option = matches[0];
  const assignment = resolveWorkflowAssignment({
    source: snapshot.source,
    category: option.category,
    transitionDescription: option.description,
    requestedTask: request.task,
    ...(request.userTask ? { userTask: request.userTask } : {}),
    ...(request.requirements ? { requestedRequirements: request.requirements } : {}),
  });
  const { requirements: _requirements, ...requestWithoutRequirements } = request;
  return {
    ...requestWithoutRequirements,
    task: assignment.task,
    ...(assignment.requirements.length > 0
      ? { requirements: [...assignment.requirements] }
      : {}),
  };
}
