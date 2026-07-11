import type { AgentRole } from "./policy.ts";
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
  readonly presetRevision: 1;
  readonly role: AgentRole;

  readonly source: {
    readonly inherited: boolean;
    readonly patch: ToolPatch;
  };

  readonly effective: readonly string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Tool names that are always rejected in patches. */
const FORBIDDEN_TOOLS = new Set([
  "subagent",
  "phenix_contract_get",
  "phenix_contract_submit",
  "phenix_complete",
]);

const EMPTY_TOOL_PATCH: ToolPatch = {
  additional: [],
  removed: [],
};

// ── Tool name validation ────────────────────────────────────────────────────

const VALID_TOOL_NAME = /^[a-z][a-z0-9_]*(\*)?$/;

/**
 * Validate and canonicalize a list of tool names.
 * Rejects forbidden tool names (subagent, obsolete contract tools, phenix_complete).
 */
function canonicalize(
  tools: readonly string[],
): readonly string[] {
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
    if (FORBIDDEN_TOOLS.has(tool)) {
      throw new Error(
        `Tool "${tool}" cannot be added or removed. It is managed by the runtime.`,
      );
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

// ── Stable unique (preserves order) ─────────────────────────────────────────

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

// ── Preset tool deduplication ───────────────────────────────────────────────

/**
 * Given a preset tool list (which may contain patterns like "lsp_*"),
 * and an additional list of tools, remove any addition that is already
 * covered by a preset pattern.
 */
function deduplicateAgainstPreset(
  preset: readonly string[],
  additions: readonly string[],
): readonly string[] {
  return additions.filter((addition) => {
    // Keep if no preset pattern already covers it.
    for (const pattern of preset) {
      if (matchTool(pattern, addition)) return false;
    }
    return true;
  });
}

// ── Clone helpers ───────────────────────────────────────────────────────────

function cloneToolPatch(patch: ToolPatch): ToolPatch {
  return {
    additional: [...patch.additional],
    removed: [...patch.removed],
  };
}

// ── Main resolution function ────────────────────────────────────────────────

/**
 * Validate that added tools do not exceed the creator's delegation ceiling.
 * If the creator has a specific set of delegable tools, additional tools
 * outside that set are rejected.
 */
function validateDelegationCeiling(
  additions: readonly string[],
  delegableTools: readonly string[] | undefined,
): void {
  if (!delegableTools || delegableTools.length === 0) return;

  const delegable = new Set(delegableTools);
  for (const tool of additions) {
    if (!delegable.has(tool)) {
      throw new Error(
        `Tool "${tool}" is not authorized for delegation from the current context.`,
      );
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

  // Resolve the patch.
  let source: { inherited: boolean; patch: ToolPatch };

  if (input.requested === null || input.requested === undefined) {
    // Inherit creator patch (or empty patch for root/not specified).
    const inherited = input.inheritedPatch ?? EMPTY_TOOL_PATCH;
    source = {
      inherited: true,
      patch: cloneToolPatch(inherited),
    };
  } else {
    // Explicit patch provided.
    const patch: ToolPatch = {
      additional: canonicalize(input.requested.additional ?? []),
      removed: canonicalize(input.requested.removed ?? []),
    };
    source = {
      inherited: false,
      patch,
    };
  }

  // Validate delegation ceiling for additions.
  validateDelegationCeiling(source.patch.additional, input.delegableTools);

  // Build the effective tool list:
  // 1. Start with preset tools
  // 2. Add requested additions (that aren't already covered by preset patterns)
  // 3. Remove anything listed in the removed set
  // 4. Apply removals last (removal wins over addition)

  const deduplicated = deduplicateAgainstPreset(base, source.patch.additional);

  const merged = stableUnique([...base, ...deduplicated]);

  const removedSet = new Set(source.patch.removed);
  const effective = merged.filter((tool) => !removedSet.has(tool));

  return {
    presetRevision: 1,
    role: input.role,
    source,
    effective,
  };
}

// ── Consumer functions ──────────────────────────────────────────────────────

/**
 * The tools visible to the model for task execution.
 * Does NOT include phenix_complete (that's communicated via the projection).
 */
export function modelTaskTools(
  config: ResolvedToolConfiguration,
): readonly string[] {
  return config.effective;
}

/**
 * The tools needed at child launch time.
 * Includes phenix_complete as a runtime capability.
 */
export function childLaunchTools(
  config: ResolvedToolConfiguration,
): readonly string[] {
  return stableUnique([...config.effective, "phenix_complete"]);
}

/**
 * Determine if a given tool name is allowed by the resolved configuration.
 * For children, this checks against effective tools + phenix_complete.
 */
export function toolAllowedByConfig(
  config: ResolvedToolConfiguration,
  toolName: string,
): boolean {
  // Always block raw subagent.
  if (toolName === "subagent") return false;
  // phenix_complete is always allowed for child contracts.
  if (toolName === "phenix_complete") return true;
  // Block obsolete contract tools.
  if (
    toolName === "phenix_contract_get" ||
    toolName === "phenix_contract_submit"
  ) {
    return false;
  }
  // Check against effective tools (including pattern matching).
  return config.effective.some((pattern) => matchTool(pattern, toolName));
}

export { EMPTY_TOOL_PATCH, matchTool };
