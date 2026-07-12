import type {
  ContractArtifact,
  ContractIdentity,
} from "./contract.ts";
import type { FileContractStore } from "./contract-store.ts";
import type { AgentRole, AgentKind } from "./agent-types.ts";
import type { ToolPatch, ToolPatchInput } from "./tool-policy.ts";
import type { DelegateRolePatchInput } from "./delegation-policy.ts";

// ── Runtime context types ───────────────────────────────────────────────────

export type PhenixRuntimeContext =
  | {
      readonly kind: "root";
      readonly workflowData?: {
        readonly instanceId: string;
        readonly actorId: string;
      };
    }
  | {
      readonly kind: "child";
      readonly identity: ContractIdentity;
      readonly contract: ContractArtifact;
      readonly store: FileContractStore;
    };

// ── Singleton state ─────────────────────────────────────────────────────────

let _context: PhenixRuntimeContext | undefined;
let _initialized = false;

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the process-local runtime context.
 *
 * Must be called exactly once during extension bootstrap.
 * Throws on re-initialization with different data.
 */
export function initializeRuntimeContext(
  context: PhenixRuntimeContext,
): void {
  if (_initialized) {
    // Allow re-initialization with identical data (idempotent).
    if (
      _context?.kind === context.kind &&
      (context.kind === "root" ||
        (context.kind === "child" &&
          (_context as typeof context).contract.id === context.contract.id))
    ) {
      return;
    }
    throw new Error(
      "Phenix runtime context has already been initialized.",
    );
  }

  _context = context;
  _initialized = true;
}

// ── Accessors ───────────────────────────────────────────────────────────────

/**
 * Get the current runtime context.
 * Returns undefined if not yet initialized.
 */
export function getRuntimeContext(): PhenixRuntimeContext | undefined {
  return _context;
}

/**
 * Get the current runtime context, throwing if not a child.
 */
export function requireChildRuntimeContext(): PhenixRuntimeContext & { kind: "child" } {
  if (!_context || _context.kind !== "child") {
    throw new Error(
      "This operation requires a Phenix child runtime context.",
    );
  }
  return _context;
}

/**
 * Get the current runtime role.
 * Returns "root" for root processes, the contract role for children,
 * or undefined if not yet initialized.
 */
export function currentRuntimeRole(): AgentRole | "root" | undefined {
  if (!_context) return undefined;
  if (_context.kind === "root") return "root";
  return _context.contract.identity.role;
}

/**
 * Get the inherited tool patch for the current child context.
 * Returns the source patch from the child's contract, suitable for
 * inheriting into further nested children.
 */
export function currentInheritedToolPatch(): ToolPatch | undefined {
  if (!_context || _context.kind !== "child") return undefined;
  return _context.contract.runtime.tools.source.patch;
}

export function currentInheritedRolePatch(): DelegateRolePatchInput | undefined {
  if (!_context || _context.kind !== "child") return undefined;
  return _context.contract.runtime.delegation.roles.source.patch;
}

export { AgentRole, AgentKind, ToolPatch, ToolPatchInput, DelegateRolePatchInput };

// ── Root workflow data setter ───────────────────────────────────────────────

/**
 * Set the root workflow instance/actor IDs on the current root context.
 * Called by the routing extension after workflow record creation.
 * Does nothing if the context is not root or not yet initialized.
 */
export function setRootWorkflowData(
  data: { readonly instanceId: string; readonly actorId: string },
): void {
  if (_context && _context.kind === "root") {
    _context = { kind: "root", workflowData: data };
  }
}

/**
 * Get the root workflow data, if set.
 */
export function getRootWorkflowData(): { readonly instanceId: string; readonly actorId: string } | undefined {
  if (_context && _context.kind === "root") {
    return _context.workflowData;
  }
  return undefined;
}
