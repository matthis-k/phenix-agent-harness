import type { AgentRole } from "./agent-types.ts";
import { rolePreset } from "./role-presets.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolPatchInput {
  readonly additional?: readonly string[];
  readonly removed?: readonly string[];
}

export interface ToolPatch {
  readonly additional: readonly string[];
  readonly removed: readonly string[];
}

export interface ResolvedToolConfiguration {
  readonly role: AgentRole;

  readonly source: {
    readonly inherited: boolean;
    readonly patch: ToolPatch;
  };

  readonly effective: readonly string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Tool names whose availability is owned exclusively by the runtime. */
const RUNTIME_TOOLS = new Set([
  "subagent",
  "phenix_complete",
  "phenix_subagent",
  "phenix_tasks",
  "phenix_workflow",
]);
const CHILD_RUNTIME_TOOLS = ["phenix_complete", "phenix_tasks", "phenix_workflow"] as const;

const EMPTY_TOOL_PATCH: ToolPatch = {
  additional: [],
  removed: [],
};

// ── Tool name validation ────────────────────────────────────────────────────

const VALID_TOOL_NAME = /^[a-z][a-z0-9_]*(\*)?$/;

/** Validate and canonicalize user-controlled task-tool patches. */
function canonicalize(tools: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const tool of tools) {
    if (typeof tool !== "string" || tool.length === 0) {
      throw new Error(
        `Invalid tool name: ${JSON.stringify(tool)}. Tool names must be non-empty strings.`,
      );
    }
    if (!VALID_TOOL_NAME.test(tool)) {
      throw new Error(
        `Invalid tool name: "${tool}". Tool names must match /^[a-z][a-z0-9_]*(\\*)?$/.`,
      );
    }
    if (RUNTIME_TOOLS.has(tool)) {
      throw new Error(`Tool "${tool}" cannot be added or removed. It is managed by the runtime.`);
    }
    result.push(tool);
  }
  return result;
}

// ── Tool matching ───────────────────────────────────────────────────────────

function matchTool(pattern: string, toolName: string): boolean {
  if (pattern.endsWith("*")) {
    return toolName.startsWith(pattern.slice(0, -1));
  }
  return pattern === toolName;
}

function stableUnique(tools: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tool of tools) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

function deduplicateAgainstPreset(
  preset: readonly string[],
  additions: readonly string[],
): readonly string[] {
  return additions.filter((addition) => {
    for (const pattern of preset) {
      if (matchTool(pattern, addition)) return false;
    }
    return true;
  });
}

function cloneToolPatch(patch: ToolPatch): ToolPatch {
  return {
    additional: [...patch.additional],
    removed: [...patch.removed],
  };
}

/**
 * Validate that the complete effective child tool set does not exceed the
 * creator's delegation ceiling.
 */
function validateDelegationCeiling(
  effective: readonly string[],
  delegableTools: readonly string[] | undefined,
): void {
  if (delegableTools === undefined) return;

  if (delegableTools.length === 0) {
    if (effective.length > 0) {
      throw new Error("No tools may be delegated from the current context.");
    }
    return;
  }

  for (const tool of effective) {
    const covered = delegableTools.some((selector) => matchTool(selector, tool));
    if (!covered) {
      throw new Error(`Tool "${tool}" is not authorized for delegation from the current context.`);
    }
  }
}

export function resolveToolConfiguration(input: {
  readonly role: AgentRole;
  readonly requested: ToolPatchInput | null | undefined;
  readonly inheritedPatch?: ToolPatch;
  readonly delegableTools?: readonly string[];
}): ResolvedToolConfiguration {
  const preset = rolePreset(input.role);
  const base = preset.tools;

  let source: { inherited: boolean; patch: ToolPatch };
  if (input.requested === null || input.requested === undefined) {
    const inherited = input.inheritedPatch ?? EMPTY_TOOL_PATCH;
    source = {
      inherited: true,
      patch: cloneToolPatch(inherited),
    };
  } else {
    const patch: ToolPatch = {
      additional: canonicalize(input.requested.additional ?? []),
      removed: canonicalize(input.requested.removed ?? []),
    };
    source = {
      inherited: false,
      patch,
    };
  }

  const deduplicated = deduplicateAgainstPreset(base, source.patch.additional);
  const merged = stableUnique([...base, ...deduplicated]);
  const removedSet = new Set(source.patch.removed);
  const effective = merged.filter((tool) => !removedSet.has(tool));

  validateDelegationCeiling(effective, input.delegableTools);

  return {
    role: input.role,
    source,
    effective,
  };
}

/** Task tools projected into the contract. */
export function modelTaskTools(config: ResolvedToolConfiguration): readonly string[] {
  return config.effective;
}

/** Contract task tools plus the mandatory runtime capabilities. */
export function childLaunchTools(config: ResolvedToolConfiguration): readonly string[] {
  return stableUnique([...config.effective, ...CHILD_RUNTIME_TOOLS]);
}

export function toolAllowedByConfig(config: ResolvedToolConfiguration, toolName: string): boolean {
  if (toolName === "subagent") return false;
  if (CHILD_RUNTIME_TOOLS.includes(toolName as (typeof CHILD_RUNTIME_TOOLS)[number])) return true;
  return config.effective.some((pattern) => matchTool(pattern, toolName));
}

export { EMPTY_TOOL_PATCH, matchTool };
