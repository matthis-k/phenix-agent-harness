import type {
  AgentRole,
  ThinkingLevel,
} from "./agent-types.ts";
import { isAgentKind } from "./agent-types.ts";
import type { ContractArtifact } from "./contract.ts";
import type { ResolvedToolConfiguration } from "./tool-policy.ts";
import { rolePreset } from "./role-presets.ts";
import { matchTool } from "./tool-policy.ts";

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

// ── Tool patch validation ───────────────────────────────────────────────────

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

// ── Tool configuration validation ───────────────────────────────────────────

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

  // Validate role field.
  const role = raw.role;
  if (role !== null && !isAgentKind(role)) {
    throw new Error(`${ctx}: runtime.tools.role must be a valid AgentKind or null`);
  }

  // Validate source.
  if (!isRecord(raw.source)) {
    throw new Error(`${ctx}: runtime.tools.source must be an object`);
  }
  if (typeof raw.source.inherited !== "boolean") {
    throw new Error(`${ctx}: runtime.tools.source.inherited must be a boolean`);
  }
  validateToolPatch(raw.source.patch, ctx);

  // Validate effective is a string array.
  if (!isStringArray(raw.effective)) {
    throw new Error(`${ctx}: runtime.tools.effective must be a string array`);
  }

  // Recompute effective tools from source and verify they match.
  // We can't fully recompute because we don't have delegableTools context,
  // but we can verify structural consistency.
  const preset = rolePreset(role as AgentRole);
  const base = preset.tools;

  // Build expected effective set (simplified recomputation).
  const patch = raw.source.patch as { additional: readonly string[]; removed: readonly string[] };
  const additions = patch.additional;
  const removed = new Set(patch.removed);

  // Deduplicate additions against preset patterns.
  const deduplicated = additions.filter((addition: string) => {
    for (const pattern of base) {
      if (matchTool(pattern, addition)) return false;
    }
    return true;
  });

  // Stable unique merge.
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

  // Compare lengths and elements.
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

// ── Main decoder ────────────────────────────────────────────────────────────

/**
 * Decode and validate a contract artifact.
 *
 * Rejects:
 * - contract versions 1 and 2 with a clear unsupported-version error.
 * - structurally invalid v3 artifacts with detailed errors.
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

  // ── version ──────────────────────────────────────────────────────────
  if (value.version === 1 || value.version === 2) {
    throw new Error(
      `${ctx()}: Contract version ${value.version} is no longer supported. ` +
      `This runtime only supports version 3.`,
    );
  }
  if (value.version !== 3) {
    throw new Error(
      `${ctx()}: Contract version must be 3, got ${JSON.stringify(value.version)}`,
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

  // Validate allowedChildren.
  if (!Array.isArray(runtime.allowedChildren)) {
    throw new Error(`${ctx()}: runtime.allowedChildren must be an array`);
  }
  for (const child of runtime.allowedChildren) {
    if (child !== null && !isAgentKind(child)) {
      throw new Error(`${ctx()}: runtime.allowedChildren contains invalid role "${child}"`);
    }
  }

  // Validate remainingDelegationDepth.
  if (!isNonNegativeInteger(runtime.remainingDelegationDepth)) {
    throw new Error(`${ctx()}: runtime.remainingDelegationDepth must be a non-negative integer`);
  }

  // Validate timeout.
  if (typeof runtime.timeoutMs !== "number" || runtime.timeoutMs < 1 || !Number.isInteger(runtime.timeoutMs)) {
    throw new Error(`${ctx()}: runtime.timeoutMs must be a positive integer`);
  }

  // Validate turnBudget.
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

  // Validate toolBudget.
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
