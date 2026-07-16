const WORKFLOW_AGENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Model-facing names that differ from their destination role.
 *
 * Names are resolved relative to the current actor. Internal transition IDs
 * remain stable persistence and audit identities and are never required from
 * the model-facing workflow API.
 */
const DELEGATION_NAME_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "d3.scout-repository": "repository-scout",
  "d3.scout-tests": "test-scout",
  "d3.scout-constraints": "constraint-scout",
});

export function workflowAgentName(input: {
  readonly transitionId: string;
  readonly role: string;
}): string {
  const name = DELEGATION_NAME_OVERRIDES[input.transitionId] ?? input.role;
  if (!WORKFLOW_AGENT_NAME.test(name)) {
    throw new Error(
      `Invalid workflow agent name "${name}" for transition "${input.transitionId}".`,
    );
  }
  return name;
}

/** Fail closed when one actor projection would expose an ambiguous local name. */
export function assertUniqueWorkflowAgentNames(
  options: readonly { readonly agent: string; readonly transitionId: string }[],
): void {
  const ownerByName = new Map<string, string>();
  for (const option of options) {
    const previous = ownerByName.get(option.agent);
    if (previous !== undefined) {
      throw new Error(
        `Ambiguous workflow agent name "${option.agent}" for transitions ` +
          `"${previous}" and "${option.transitionId}".`,
      );
    }
    ownerByName.set(option.agent, option.transitionId);
  }
}
