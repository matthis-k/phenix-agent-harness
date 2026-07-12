import type { AgentRole, AgentKind } from "./agent-types.ts";
import { rolePreset } from "./role-presets.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DelegateRolePatchInput {
  readonly additional?: readonly AgentRole[];
  readonly removed?: readonly AgentRole[];
}

export interface DelegateRolePatch {
  readonly additional: readonly AgentRole[];
  readonly removed: readonly AgentRole[];
}

export interface ResolvedDelegateRoleConfiguration {
  readonly presetRevision: 1;

  /**
   * Role whose preset supplied the baseline child-role set.
   */
  readonly role: AgentRole;

  readonly source: {
    readonly inherited: boolean;
    readonly patch: DelegateRolePatch;
  };

  /**
   * Contract-authorized child roles before installation availability
   * and state-specific workflow filtering.
   */
  readonly effective: readonly AgentRole[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const EMPTY_ROLE_PATCH: DelegateRolePatch = {
  additional: [],
  removed: [],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function stableUnique(roles: readonly AgentRole[]): readonly AgentRole[] {
  const seen = new Set<AgentRole>();
  const result: AgentRole[] = [];
  for (const role of roles) {
    if (!seen.has(role)) {
      seen.add(role);
      result.push(role);
    }
  }
  return result;
}

function isValidAgentRole(value: unknown): value is AgentRole {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const AGENT_KINDS: readonly string[] = [
    "scout", "planner", "architect", "implementer",
    "tester", "critic", "finalizer",
  ];
  return AGENT_KINDS.includes(value);
}

function cloneRolePatch(patch: DelegateRolePatch): DelegateRolePatch {
  return {
    additional: [...patch.additional],
    removed: [...patch.removed],
  };
}

// ── Main resolution function ────────────────────────────────────────────────

/**
 * Resolve the delegate role configuration for a child contract.
 *
 * Semantics:
 * - baseline = rolePreset(role).allowedChildren
 * - requested == null => inherit creator's semantic role patch
 * - requested is {} => explicit empty patch; do not inherit
 * - removal wins over addition
 * - preserve preset order, append additions in request order
 * - deduplicate
 * - do not mutate inputs
 * - role: null starts from an empty baseline
 * - explicit additions must be valid AgentRole values
 * - the complete effective set must fit within the creator ceiling
 * - do not silently clip unauthorized roles
 * - an empty creator ceiling means no child targets
 */
export function resolveDelegateRoleConfiguration(input: {
  readonly role: AgentRole;
  readonly requested: DelegateRolePatchInput | null | undefined;
  readonly inheritedPatch?: DelegateRolePatch;
  readonly delegableRoles?: readonly AgentRole[];
}): ResolvedDelegateRoleConfiguration {
  const preset = rolePreset(input.role);
  const baseline = preset.allowedChildren as readonly AgentRole[];

  // Resolve the patch
  let source: { inherited: boolean; patch: DelegateRolePatch };

  if (input.requested === null || input.requested === undefined) {
    // Inherit creator patch (or empty patch for root/not specified)
    const inherited = input.inheritedPatch ?? EMPTY_ROLE_PATCH;
    source = {
      inherited: true,
      patch: cloneRolePatch(inherited),
    };
  } else {
    // Explicit patch provided
    const additional = (input.requested.additional ?? []).filter(
      (r) => {
        if (!isValidAgentRole(r)) {
          throw new Error(`Invalid AgentRole in delegateRoles.additional: ${String(r)}`);
        }
        return true;
      },
    );
    const removed = (input.requested.removed ?? []).filter(
      (r) => {
        if (!isValidAgentRole(r)) {
          throw new Error(`Invalid AgentRole in delegateRoles.removed: ${String(r)}`);
        }
        return true;
      },
    );
    const patch: DelegateRolePatch = { additional, removed };
    source = {
      inherited: false,
      patch,
    };
  }

  // Build effective set:
  // 1. Start with baseline (preset order)
  // 2. Add requested additions (not already present)
  // 3. Remove anything listed in removed set
  // 4. Deduplicate

  const merged = stableUnique([...baseline, ...source.patch.additional]);
  const removedSet = new Set(source.patch.removed);
  let effective = merged.filter((role) => !removedSet.has(role));

  // Validate against delegation ceiling
  const delegableRoles = input.delegableRoles;
  if (delegableRoles !== undefined) {
    // Empty = no delegation allowed at all
    if (delegableRoles.length === 0) {
      if (effective.length > 0) {
        throw new Error(
          "No child roles may be delegated from the current context.",
        );
      }
      effective = [];
    } else {
      // Every effective target must be covered
      for (const role of effective) {
        if (!delegableRoles.includes(role)) {
          throw new Error(
            `Role "${role ?? "base"}" is not authorized for delegation from the current context.`,
          );
        }
      }
    }
  }

  return {
    presetRevision: 1,
    role: input.role,
    source,
    effective,
  };
}

// ── Interal critic delegation patch ─────────────────────────────────────────

export const INTERNAL_CRITIC_DELEGATION: DelegateRolePatchInput = {
  additional: [],
  removed: ["scout", "tester"],
};
