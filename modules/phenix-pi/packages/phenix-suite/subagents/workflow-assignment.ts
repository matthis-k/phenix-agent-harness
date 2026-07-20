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
  const isRequiredRoot =
    input.source === "root" && input.category === "required" && Boolean(userTask);

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
