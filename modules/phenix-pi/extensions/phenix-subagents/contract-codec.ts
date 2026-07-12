import type {
  AgentRole,
  ThinkingLevel,
} from "./agent-types.ts";
import { isAgentKind } from "./agent-types.ts";
import { CONTRACT_SCHEMA_VERSION, type ContractArtifact } from "./contract.ts";
import type { ResolvedToolConfiguration } from "./tool-policy.ts";
import type { ResolvedDelegateRoleConfiguration } from "./delegation-policy.ts";
import { rolePreset } from "./role-presets.ts";
import { matchTool } from "./tool-policy.ts";
import { getWorkflowDefinition } from "../phenix-workflow/workflow-definitions.ts";

// ── Guard functions ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === value;
}

function isStringOrUndefined(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isFinite(value)
  );
}

const VALID_THINKING: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && VALID_THINKING.has(value);
}

const VALID_DIFFICULTIES: ReadonlySet<string> = new Set(["D0", "D1", "D2", "D3"]);

// ── Tool patch validation (unchanged) ───────────────────────────────────────

function validateToolPatch(
  patch: unknown,
  context: string,
): asserts patch is { additional: readonly string[]; removed: readonly string[] } {
  if (!isRecord(patch)) {
    throw new Error(`${context}: tool source.patch must be an object`);
  }
  if (!Array.isArray(patch.additional) || !patch.additional.every((v) => typeof v === "string")) {
    throw new Error(`${context}: tool source.patch.additional must be a string array`);
  }
  if (!Array.isArray(patch.removed) || !patch.removed.every((v) => typeof v === "string")) {
    throw new Error(`${context}: tool source.patch.removed must be a string array`);
  }
}

// ── Tool configuration validation (unchanged core) ──────────────────────────

function validateToolConfiguration(
  raw: unknown,
  contractId: string,
): asserts raw is ResolvedToolConfiguration {
  const ctx = `Contract ${contractId}`;

  if (!isRecord(raw)) {
    throw new Error(`${ctx}: runtime.tools must be an object`);
  }

  if (raw.presetRevision !== 1) {
    throw new Error(`${ctx}: unsupported runtime.tools.presetRevision`);
  }

  const role = raw.role;
  if (role !== null && !isAgentKind(role)) {
    throw new Error(`${ctx}: runtime.tools.role must be a valid AgentKind or null`);
  }

  if (!isRecord(raw.source)) {
    throw new Error(`${ctx}: runtime.tools.source must be an object`);
  }
  if (typeof raw.source.inherited !== "boolean") {
    throw new Error(`${ctx}: runtime.tools.source.inherited must be a boolean`);
  }
  validateToolPatch(raw.source.patch, ctx);

  if (!isStringArray(raw.effective)) {
    throw new Error(`${ctx}: runtime.tools.effective must be a string array`);
  }

  const preset = rolePreset(role as AgentRole);
  const base = preset.tools;

  const patch = raw.source.patch as { additional: readonly string[]; removed: readonly string[] };
  const additions = patch.additional;
  const removed = new Set(patch.removed);

  const deduplicated = additions.filter((addition: string) => {
    for (const pattern of base) {
      if (matchTool(pattern, addition)) return false;
    }
    return true;
  });

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tool of base) {
    if (!seen.has(tool) && !removed.has(tool)) {
      seen.add(tool);
      merged.push(tool);
    }
  }
  for (const tool of deduplicated) {
    if (!seen.has(tool) && !removed.has(tool)) {
      seen.add(tool);
      merged.push(tool);
    }
  }

  const effective = raw.effective as readonly string[];
  if (merged.length !== effective.length) {
    throw new Error(
      `${ctx}: runtime.tools.effective is inconsistent with source.patch. ` +
      `Expected ${merged.length} tools, got ${effective.length}`,
    );
  }
  for (let i = 0; i < merged.length; i++) {
    if (merged[i] !== effective[i]) {
      throw new Error(
        `${ctx}: runtime.tools.effective is inconsistent with source.patch at index ${i}. ` +
        `Expected "${merged[i]}", got "${effective[i]}"`,
      );
    }
  }
}

// ── Role patch validation ───────────────────────────────────────────────────

function validateRolePatch(
  patch: unknown,
  context: string,
): asserts patch is { additional: readonly AgentRole[]; removed: readonly AgentRole[] } {
  if (!isRecord(patch)) {
    throw new Error(`${context}: delegation roles source.patch must be an object`);
  }
  if (!Array.isArray(patch.additional)) {
    throw new Error(`${context}: delegation roles source.patch.additional must be an array`);
  }
  for (const r of patch.additional) {
    if (r !== null && !isAgentKind(r)) {
      throw new Error(`${context}: delegation roles source.patch.additional contains invalid role "${String(r)}"`);
    }
  }
  if (!Array.isArray(patch.removed)) {
    throw new Error(`${context}: delegation roles source.patch.removed must be an array`);
  }
  for (const r of patch.removed) {
    if (r !== null && !isAgentKind(r)) {
      throw new Error(`${context}: delegation roles source.patch.removed contains invalid role "${String(r)}"`);
    }
  }
}

// ── Delegation roles validation ─────────────────────────────────────────────

function validateDelegationRoles(
  raw: unknown,
  contractId: string,
  identityRole: AgentRole,
): asserts raw is ResolvedDelegateRoleConfiguration {
  const ctx = `Contract ${contractId}`;

  if (!isRecord(raw)) {
    throw new Error(`${ctx}: runtime.delegation.roles must be an object`);
  }

  if (raw.presetRevision !== 1) {
    throw new Error(`${ctx}: unsupported runtime.delegation.roles.presetRevision`);
  }

  // role must match identity.role
  if (raw.role !== identityRole) {
    throw new Error(
      `${ctx}: runtime.delegation.roles.role "${raw.role}" does not match identity.role "${identityRole}"`,
    );
  }

  // validate source
  if (!isRecord(raw.source)) {
    throw new Error(`${ctx}: runtime.delegation.roles.source must be an object`);
  }
  if (typeof raw.source.inherited !== "boolean") {
    throw new Error(`${ctx}: runtime.delegation.roles.source.inherited must be a boolean`);
  }
  validateRolePatch(raw.source.patch, ctx);

  // validate effective is an array of valid roles
  if (!Array.isArray(raw.effective)) {
    throw new Error(`${ctx}: runtime.delegation.roles.effective must be an array`);
  }
  for (const r of raw.effective) {
    if (r !== null && !isAgentKind(r)) {
      throw new Error(`${ctx}: runtime.delegation.roles.effective contains invalid role "${String(r)}"`);
    }
  }
}

// ── Workflow validation ─────────────────────────────────────────────────────

function validateWorkflowSection(
  raw: unknown,
  contractId: string,
): void {
  const ctx = `Contract ${contractId}`;

  if (!isRecord(raw)) {
    throw new Error(`${ctx}: runtime.workflow must be an object`);
  }

  if (!isNonEmptyString(raw.instanceId)) {
    throw new Error(`${ctx}: runtime.workflow.instanceId must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.actorId)) {
    throw new Error(`${ctx}: runtime.workflow.actorId must be a non-empty string`);
  }
  if (raw.parentActorId !== undefined && !isNonEmptyString(raw.parentActorId)) {
    throw new Error(`${ctx}: runtime.workflow.parentActorId must be a string or undefined`);
  }

  // Validate definition exists
  const defId = raw.definitionId as string;
  const definition = getWorkflowDefinition(defId);
  if (!definition) {
    throw new Error(`${ctx}: unknown workflow definition "${defId}"`);
  }
  if (raw.definitionVersion !== 1) {
    throw new Error(`${ctx}: unsupported workflow definitionVersion`);
  }

  // Validate difficulty
  if (!VALID_DIFFICULTIES.has(raw.difficulty as string)) {
    throw new Error(`${ctx}: invalid workflow difficulty "${raw.difficulty}"`);
  }

  // Validate initialState exists in definition
  const initialState = raw.initialState as string;
  const stateExists = definition.transitions.some(
    (t) =>
      (t.kind === "delegate" && t.from.includes(initialState as never)) ||
      (t.kind === "automatic" && t.from === initialState),
  ) || definition.initialState === initialState;
  if (!stateExists) {
    throw new Error(
      `${ctx}: workflow initialState "${initialState}" is not a valid state in definition "${defId}"`,
    );
  }

  // Validate transitionCeiling
  if (!Array.isArray(raw.transitionCeiling)) {
    throw new Error(`${ctx}: runtime.workflow.transitionCeiling must be an array`);
  }
  for (const tid of raw.transitionCeiling) {
    if (typeof tid !== "string" || tid.length === 0) {
      throw new Error(`${ctx}: runtime.workflow.transitionCeiling contains invalid transition ID`);
    }
    const exists = definition.transitions.some((t) => t.id === tid);
    if (!exists) {
      throw new Error(
        `${ctx}: runtime.workflow.transitionCeiling references unknown transition ID "${tid}"`,
      );
    }
  }

  // Validate capability artifact hash format (SHA-256 hex)
  if (!isNonEmptyString(raw.capabilityArtifactHash) || !/^[0-9a-f]{64}$/.test(raw.capabilityArtifactHash)) {
    throw new Error(`${ctx}: invalid runtime.workflow.capabilityArtifactHash`);
  }
}

// ── Main decoder ────────────────────────────────────────────────────────────

/**
 * Decode and validate a contract artifact.
 *
 * Rejects:
 * - contract versions 1-3 with a clear unsupported-version error.
 * - structurally invalid v4 artifacts with detailed errors.
 */
export function decodeContractArtifact(
  value: unknown,
): ContractArtifact {
  if (!isRecord(value)) {
    throw new Error("Contract artifact must be an object");
  }

  const ctx = () => {
    const id = typeof value.id === "string" ? value.id : "(unknown)";
    return `Contract ${id}`;
  };

  // ── schemaVersion ────────────────────────────────────────────────────
  if (value.schemaVersion !== 1) {
    throw new Error(
      `${ctx()}: Unsupported contract schema version ${JSON.stringify(value.schemaVersion)}. ` +
      `Expected ${CONTRACT_SCHEMA_VERSION}. This runtime does not support migration. ` +
      `Delete .phenix-agent-state if it contains stale development artifacts.`,
    );
  }

  // ── id ───────────────────────────────────────────────────────────────
  if (!isNonEmptyString(value.id) || !/^phx_[0-9a-f-]{36}$/i.test(value.id)) {
    throw new Error(`${ctx()}: invalid contract id`);
  }

  // ── identity ──────────────────────────────────────────────────────────
  if (!isRecord(value.identity)) {
    throw new Error(`${ctx()}: identity must be an object`);
  }
  const identity = value.identity;
  if (!isNonEmptyString(identity.runId) || !/^run_[0-9a-f-]{36}$/i.test(identity.runId)) {
    throw new Error(`${ctx()}: invalid identity.runId`);
  }
  if (!isStringOrUndefined(identity.parentRunId)) {
    throw new Error(`${ctx()}: identity.parentRunId must be a string or undefined`);
  }
  if (identity.parentRunId !== undefined && (!/^run_[0-9a-f-]{36}$/i.test(identity.parentRunId))) {
    throw new Error(`${ctx()}: invalid identity.parentRunId`);
  }
  if (!isNonEmptyString(identity.handleId)) {
    throw new Error(`${ctx()}: identity.handleId must be a non-empty string`);
  }
  if (!isStringOrUndefined(identity.parentHandleId)) {
    throw new Error(`${ctx()}: identity.parentHandleId must be a string or undefined`);
  }
  const role = identity.role;
  if (role !== null && !isAgentKind(role)) {
    throw new Error(`${ctx()}: identity.role must be a valid AgentKind or null`);
  }

  // ── assignment ────────────────────────────────────────────────────────
  if (!isRecord(value.assignment)) {
    throw new Error(`${ctx()}: assignment must be an object`);
  }
  const assignment = value.assignment;
  if (!isNonEmptyString(assignment.task)) {
    throw new Error(`${ctx()}: assignment.task must be a non-empty string`);
  }
  if (!isStringArray(assignment.requirements)) {
    throw new Error(`${ctx()}: assignment.requirements must be a string array`);
  }
  if (!isRecord(assignment.outputSchema)) {
    throw new Error(`${ctx()}: assignment.outputSchema must be an object`);
  }

  // ── runtime ───────────────────────────────────────────────────────────
  if (!isRecord(value.runtime)) {
    throw new Error(`${ctx()}: runtime must be an object`);
  }
  const runtime = value.runtime;

  // Validate agent matches rolePreset.
  const preset = rolePreset(role);
  if (runtime.agent !== preset.agentName) {
    throw new Error(
      `${ctx()}: runtime.agent "${runtime.agent}" does not match ` +
      `rolePreset agent "${preset.agentName}" for role ${role}`,
    );
  }

  // Validate cwd is absolute.
  if (!isNonEmptyString(runtime.cwd) || !runtime.cwd.startsWith("/")) {
    throw new Error(`${ctx()}: runtime.cwd must be an absolute path`);
  }

  // Validate model (optional).
  if (!isStringOrUndefined(runtime.model)) {
    throw new Error(`${ctx()}: runtime.model must be a string or undefined`);
  }

  // Validate thinking level.
  if (!isThinkingLevel(runtime.thinking)) {
    throw new Error(`${ctx()}: runtime.thinking must be a valid ThinkingLevel`);
  }

  // Validate tools.
  validateToolConfiguration(runtime.tools, value.id);

  // Validate tools.role matches identity.role.
  if (runtime.tools.role !== role) {
    throw new Error(
      `${ctx()}: runtime.tools.role "${runtime.tools.role}" does not match identity.role "${role}"`,
    );
  }

  // Validate skills and extensions.
  if (!isStringArray(runtime.skills)) {
    throw new Error(`${ctx()}: runtime.skills must be a string array`);
  }
  if (!isStringArray(runtime.extensions)) {
    throw new Error(`${ctx()}: runtime.extensions must be a string array`);
  }

  // ── Validate delegation section (v4) ──────────────────────────────────
  if (!isRecord(runtime.delegation)) {
    throw new Error(`${ctx()}: runtime.delegation must be an object`);
  }
  const delegation = runtime.delegation;

  // Validate delegation.roles
  validateDelegationRoles(delegation.roles, value.id, role);

  // Validate availableRoles is subset of effective roles
  if (!Array.isArray(delegation.availableRoles)) {
    throw new Error(`${ctx()}: runtime.delegation.availableRoles must be an array`);
  }
  const effectiveRoleSet = new Set(delegation.roles.effective as readonly AgentRole[]);
  for (const ar of delegation.availableRoles) {
    if (ar !== null && !isAgentKind(ar)) {
      throw new Error(`${ctx()}: runtime.delegation.availableRoles contains invalid role "${String(ar)}"`);
    }
    if (!effectiveRoleSet.has(ar)) {
      throw new Error(
        `${ctx()}: runtime.delegation.availableRoles contains "${ar}" which is not in effective roles`,
      );
    }
  }

  // Validate remainingDepth
  if (!isNonNegativeInteger(delegation.remainingDepth)) {
    throw new Error(`${ctx()}: runtime.delegation.remainingDepth must be a non-negative integer`);
  }

  // ── Validate workflow section (v4) ────────────────────────────────────
  validateWorkflowSection(runtime.workflow, value.id);

  // ── Validate timeout ──────────────────────────────────────────────────
  if (typeof runtime.timeoutMs !== "number" || runtime.timeoutMs < 1 || !Number.isInteger(runtime.timeoutMs)) {
    throw new Error(`${ctx()}: runtime.timeoutMs must be a positive integer`);
  }

  // ── Validate turnBudget ───────────────────────────────────────────────
  if (!isRecord(runtime.turnBudget)) {
    throw new Error(`${ctx()}: runtime.turnBudget must be an object`);
  }
  const turnBudget = runtime.turnBudget;
  if (typeof turnBudget.maxTurns !== "number" || turnBudget.maxTurns < 1 || !Number.isInteger(turnBudget.maxTurns)) {
    throw new Error(`${ctx()}: runtime.turnBudget.maxTurns must be a positive integer`);
  }
  if (typeof turnBudget.graceTurns !== "number" || turnBudget.graceTurns < 0 || !Number.isInteger(turnBudget.graceTurns)) {
    throw new Error(`${ctx()}: runtime.turnBudget.graceTurns must be a non-negative integer`);
  }

  // ── Validate toolBudget ───────────────────────────────────────────────
  if (!isRecord(runtime.toolBudget)) {
    throw new Error(`${ctx()}: runtime.toolBudget must be an object`);
  }
  const toolBudget = runtime.toolBudget;
  if (typeof toolBudget.soft !== "number" || toolBudget.soft < 1 || !Number.isInteger(toolBudget.soft)) {
    throw new Error(`${ctx()}: runtime.toolBudget.soft must be a positive integer`);
  }
  if (typeof toolBudget.hard !== "number" || toolBudget.hard < 1 || !Number.isInteger(toolBudget.hard)) {
    throw new Error(`${ctx()}: runtime.toolBudget.hard must be a positive integer`);
  }
  if (toolBudget.soft > toolBudget.hard) {
    throw new Error(`${ctx()}: runtime.toolBudget.soft (${toolBudget.soft}) must be <= hard (${toolBudget.hard})`);
  }
  if (!isStringArray(toolBudget.block)) {
    throw new Error(`${ctx()}: runtime.toolBudget.block must be a string array`);
  }

  // ── verification ──────────────────────────────────────────────────────
  if (!isRecord(value.verification)) {
    throw new Error(`${ctx()}: verification must be an object`);
  }
  const verification = value.verification;
  if (!Array.isArray(verification.commands)) {
    throw new Error(`${ctx()}: verification.commands must be an array`);
  }
  for (const cmd of verification.commands) {
    if (!isRecord(cmd) || !isNonEmptyString(cmd.id) || !isNonEmptyString(cmd.command)) {
      throw new Error(`${ctx()}: verification.commands entries must have id and command`);
    }
  }
  if (typeof verification.criticRequired !== "boolean") {
    throw new Error(`${ctx()}: verification.criticRequired must be a boolean`);
  }
  if (!isNonNegativeInteger(verification.maxRepairAttempts)) {
    throw new Error(`${ctx()}: verification.maxRepairAttempts must be a non-negative integer`);
  }

  // ── capabilityTokenHash ───────────────────────────────────────────────
  if (!isNonEmptyString(value.capabilityTokenHash) || !/^[0-9a-f]{64}$/.test(value.capabilityTokenHash)) {
    throw new Error(`${ctx()}: invalid capabilityTokenHash`);
  }

  // ── timestamps ────────────────────────────────────────────────────────
  if (!isStrictIsoTimestamp(value.createdAt)) {
    throw new Error(`${ctx()}: createdAt must be a valid ISO timestamp`);
  }
  if (value.expiresAt !== undefined) {
    if (!isStrictIsoTimestamp(value.expiresAt)) {
      throw new Error(`${ctx()}: expiresAt must be a valid ISO timestamp or undefined`);
    }
  }

  // All checks passed.
  return value as unknown as ContractArtifact;
}
