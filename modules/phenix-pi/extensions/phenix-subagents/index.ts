import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { SubagentParamsLike } from "pi-subagents/src/runs/foreground/subagent-executor.ts";
import type { Details } from "pi-subagents/src/shared/types.ts";

import {
  SubagentBackend,
  type AsyncResultPayload,
  type RuntimeChildResult,
} from "./backend.ts";
import {
  assertOutputSchema,
  type JsonSchema,
} from "./contracts.ts";
import {
  isAgentKind,
  loadPolicyConfig,
  resolveExecutionPolicy,
  type AgentKind,
  type AgentRole,
  type ProfileHint,
  type ResolvedExecutionPolicy,
} from "./policy.ts";
import {
  rolePreset,
} from "./role-presets.ts";
import {
  resolveToolConfiguration,
  type ToolPatchInput,
  type ToolPatch,
  EMPTY_TOOL_PATCH,
} from "./tool-policy.ts";
import {
  runVerificationCommands,
  type VerificationRun,
} from "./verification.ts";
import {
  type ContractId,
} from "./contract.ts";
import {
  FileContractStore,
  ContractStoreError,
} from "./contract-store.ts";
import {
  getRuntimeContext,
} from "./contract-runtime-context.ts";

import {
  HANDLE_VERSION,
  TERMINAL_STATES,
  type AttemptRecord,
  type CriticFinding,
  type CriticValue,
  type Evaluation,
  type HandleRecord,
} from "./handle-types.ts";
import {
  currentParentRecord,
  effectiveSessionId,
  findProjectRoot,
  latestAttempt,
  listRecords,
  now,
  readRecord,
  recordChildSessions,
  writeRecord,
} from "./handle-store.ts";
import {
  childContractEnv,
  createAttemptContract,
  evaluateContractResult,
  repairTask,
} from "./handle-evaluation.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

// ── Generic bootstrap task for child contracts ──────────────────────────────

const CHILD_BOOTSTRAP_TASK =
  "Execute the Phenix assignment initialized by the child runtime.";

// ── Delegate input types ────────────────────────────────────────────────────

interface DelegateInput {
  readonly role: AgentRole;
  readonly task: string;
  readonly outputSchema: JsonSchema;
  readonly requirements: readonly string[];
  readonly tools?: ToolPatchInput | null;
  readonly profile?: ProfileHint;
  readonly mode: "await" | "background";
  readonly parent?: string;
}

// ── TypeBox schemas ─────────────────────────────────────────────────────────

const JsonSchemaObject = Type.Unsafe({
  type: "object",
  additionalProperties: true,
  description: "Strict JSON Schema object for the child handoff.",
});

const ProfileSchema = Type.Object(
  {
    complexity: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    uncertainty: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    consequence: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    breadth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    coupling: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    novelty: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
  },
  { additionalProperties: false },
);

const ToolPatchSchema = Type.Optional(
  Type.Unsafe({
    type: "object",
    properties: {
      additional: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Tools to add to the role preset.",
        }),
      ),
      removed: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          description: "Tools to remove from the role preset.",
        }),
      ),
    },
    additionalProperties: false,
    description: "Tool patch for the child role preset.",
  }),
);

const DelegateRoleSchema = Type.Unsafe({
  anyOf: [
    { type: "string", enum: ["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"] },
    { type: "null" },
  ],
  description: "Agent role (one of the standard roles, or null for no preset).",
});

const DelegateParams = Type.Object(
  {
    role: DelegateRoleSchema,
    task: Type.String({ minLength: 1 }),
    outputSchema: JsonSchemaObject,
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
    tools: ToolPatchSchema,
    profile: Type.Optional(ProfileSchema),
    mode: Type.Optional(Type.String({ enum: ["await", "background"] })),
    parent: Type.Optional(Type.String({ minLength: 1, description: "Optional semantic parent handle. Normally inferred for nested agents." })),
  },
  { additionalProperties: false },
);

const AgentParams = Type.Object(
  {
    action: Type.String({ enum: ["await", "poll", "cancel", "inspect", "tree"] }),
    id: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function storeRoot(): string {
  return path.join(
    findProjectRoot(process.cwd()),
    ".phenix-agent-state",
    "contracts",
  );
}

async function cancelPendingContracts(attempt: AttemptRecord): Promise<void> {
  const store = new FileContractStore(storeRoot());
  const ids: Array<{ id: ContractId; label: string }> = [];
  if (attempt.contractId) ids.push({ id: attempt.contractId, label: "producer" });
  if (attempt.criticContractId) ids.push({ id: attempt.criticContractId, label: "critic" });
  for (const { id } of ids) {
    try {
      await store.cancel(id, `superseded-by-repair`);
    } catch (error) {
      if (error instanceof ContractStoreError && error.code === "already-terminal") continue;
      if (error instanceof ContractStoreError && error.code === "not-found") continue;
      throw error;
    }
  }
}

function compactOutput(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function formatVerificationRun(run: VerificationRun): string {
  const output = compactOutput(run.stderr) ?? compactOutput(run.stdout);
  return [
    `${run.id}: ${run.status}`,
    run.exitCode !== null ? `exit ${run.exitCode}` : undefined,
    output,
  ].filter(Boolean).join("; ");
}

function criticFindingText(finding: CriticFinding): string {
  return [
    finding.severity,
    finding.requirement ? `requirement ${finding.requirement}` : undefined,
    finding.description,
    finding.evidence,
  ].filter(Boolean).join(": ");
}

function applyThinking(model: string | undefined, thinking: string): string | undefined {
  if (!model) return undefined;
  const index = model.lastIndexOf(":");
  if (index >= 0 && THINKING_LEVELS.has(model.slice(index + 1))) {
    return `${model.slice(0, index)}:${thinking}`;
  }
  return `${model}:${thinking}`;
}

function currentModelId(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
  return typeof model?.provider === "string" && typeof model.id === "string"
    ? `${model.provider}/${model.id}`
    : undefined;
}

function materializePolicyModel(
  policy: ResolvedExecutionPolicy,
  ctx: ExtensionContext,
): ResolvedExecutionPolicy {
  return policy.model ? policy : { ...policy, ...(currentModelId(ctx) ? { model: currentModelId(ctx) } : {}) };
}

function criticTask(record: HandleRecord): string {
  const requirements = record.requirements.length > 0
    ? record.requirements.map((requirement, index) => `${index + 1}. ${requirement}`).join("\n")
    : "1. Complete the delegated task exactly as specified.";
  return [
    "Independently review the completed handoff and the actual workspace state.",
    "Do not trust the producer's confidence or claimed checks. Inspect concrete files and diagnostics as needed.",
    "Reject for any major or critical defect, missing required work, unsafe change, unsupported completion claim, or material untested path.",
    "Minor findings may be reported without rejecting.",
    "",
    "Original delegated task:",
    record.task,
    "",
    "Requirements:",
    requirements,
    "",
    "Return the runtime-provided critic schema using phenix_complete.",
  ].join("\n");
}

// ── Child authorization ─────────────────────────────────────────────────────

function resolveRoleForPolicy(role: AgentRole): AgentKind {
  if (role === null) {
    // For null role, use "scout" as the policy base since there's no
    // meaningful "null" role in resolveExecutionPolicy. The actual role
    // preset for tools comes from resolveToolConfiguration.
    return "scout";
  }
  return role;
}

function childAllowedByContext(child: AgentRole): boolean {
  const ctx = getRuntimeContext();
  if (!ctx || ctx.kind === "root") return true;
  if (child === null) return false; // null role children not allowed from child contracts
  return ctx.contract.runtime.allowedChildren.includes(child);
}

function currentInheritedPatch(): ToolPatch {
  const ctx = getRuntimeContext();
  if (ctx?.kind === "child") {
    // Use the source patch (semantic intent), not the effective tools.
    return ctx.contract.runtime.tools.source.patch;
  }
  return EMPTY_TOOL_PATCH;
}

// ── Subagent params builders ────────────────────────────────────────────────

function buildProducerSubagentParams(
  record: HandleRecord,
): SubagentParamsLike {
  const primaryStep: Record<string, unknown> = {
    agent: record.policy.agent,
    task: CHILD_BOOTSTRAP_TASK,
    as: "primary",
    acceptance: record.policy.acceptance,
    toolBudget: record.policy.toolBudget,
    phase: record.role === null ? "base" : record.role,
    label: record.role === null ? "base handoff" : `${record.role} handoff`,
    ...(applyThinking(record.policy.model, record.policy.thinking)
      ? { model: applyThinking(record.policy.model, record.policy.thinking) }
      : {}),
  };

  const chain: Record<string, unknown>[] = [primaryStep];

  return {
    chain: chain as never,
    context: "fresh",
    async: false,
    clarify: false,
    artifacts: true,
    includeProgress: false,
    timeoutMs: record.policy.timeoutMs,
    turnBudget: {
      maxTurns: record.policy.turnBudget.maxTurns,
      graceTurns: record.policy.turnBudget.graceTurns,
    },
    agentScope: "both",
  };
}

function buildCriticSubagentParams(
  record: HandleRecord,
): SubagentParamsLike {
  const criticStep: Record<string, unknown> = {
    agent: record.reviewPolicy!.agent,
    task: CHILD_BOOTSTRAP_TASK,
    as: "critic",
    acceptance: record.reviewPolicy!.acceptance,
    toolBudget: record.reviewPolicy!.toolBudget,
    phase: "critic",
    label: `${record.role} independent critic`,
    ...(applyThinking(record.reviewPolicy!.model, record.reviewPolicy!.thinking)
      ? { model: applyThinking(record.reviewPolicy!.model, record.reviewPolicy!.thinking) }
      : {}),
  };

  return {
    chain: [criticStep] as never,
    context: "fresh",
    async: false,
    clarify: false,
    artifacts: true,
    includeProgress: false,
    timeoutMs: record.reviewPolicy!.timeoutMs,
    turnBudget: {
      maxTurns: record.reviewPolicy!.turnBudget.maxTurns,
      graceTurns: record.reviewPolicy!.turnBudget.graceTurns,
    },
    agentScope: "both",
  };
}

// ── Result helpers ──────────────────────────────────────────────────────────

function resultPayload(record: HandleRecord): Record<string, unknown> {
  return {
    status: record.status,
    handleId: record.id,
    parentId: record.parentId,
    role: record.role,
    value: record.value,
    errors: record.errors,
    verification: record.verification,
    review: record.review,
    attempts: record.attempts.map((attempt) => ({
      number: attempt.number,
      runId: attempt.runId,
      phenixRunId: attempt.phenixRunId,
      contractId: attempt.contractId,
      criticContractId: attempt.criticContractId,
      mode: attempt.mode,
      status: attempt.status,
      startedAt: attempt.startedAt,
      endedAt: attempt.endedAt,
      error: attempt.error,
      childSessions: attempt.childSessions,
    })),
    policy: {
      tier: record.policy.tier,
      model: record.policy.model ?? "inherit",
      thinking: record.policy.thinking,
      expectedAcceptance: record.policy.expectedAcceptance,
      criticRequired: Boolean(record.reviewPolicy),
    },
  };
}

function toolResult(record: HandleRecord): AgentToolResult<Record<string, unknown>> {
  const payload = resultPayload(record);
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(record.status === "failed" ? { isError: true } : {}),
    details: payload,
  };
}

function markEvaluation(
  cwd: string,
  record: HandleRecord,
  evaluation: Evaluation,
): void {
  const attempt = latestAttempt(record);
  attempt.endedAt = now();
  attempt.status = evaluation.ok ? "completed" : "failed";
  if (!evaluation.ok) attempt.error = evaluation.errors.join(" | ");
  record.verification = evaluation.verification;
  record.review = evaluation.review;

  if (evaluation.ok) {
    record.status = "completed";
    record.value = evaluation.value;
    record.errors = undefined;
  } else {
    record.errors = [...evaluation.errors];
  }
  writeRecord(cwd, record);
}

function canRepair(record: HandleRecord, evaluation: Evaluation): boolean {
  const completedAttempts = record.attempts.filter((attempt) => attempt.status !== "running").length;
  return evaluation.repairable && completedAttempts <= record.policy.maxRepairAttempts;
}

// ── Record creation ─────────────────────────────────────────────────────────

function createRecord(
  ctx: ExtensionContext,
  input: DelegateInput,
  parent: HandleRecord | undefined,
): HandleRecord {
  const config = loadPolicyConfig();
  const policyRole = resolveRoleForPolicy(input.role);

  // Resolve tool configuration.
  const resolvedTools = resolveToolConfiguration({
    role: input.role,
    requested: input.tools,
    inheritedPatch: currentInheritedPatch(),
  });

  // Resolve execution policy using the role-appropriate base.
  const policy = materializePolicyModel(resolveExecutionPolicy({
    role: policyRole,
    task: input.task,
    requirements: input.requirements,
    profileHint: input.profile,
    cwd: ctx.cwd,
    config,
  }), ctx);

  // Override the policy agent and tools with the resolved values.
  const resolvedAgent = rolePreset(input.role).agentName;
  const resolvedAllowedChildren = rolePreset(input.role).allowedChildren;
  const resolvedPolicy: ResolvedExecutionPolicy = {
    ...policy,
    agent: resolvedAgent as ResolvedExecutionPolicy["agent"],
    allowedTools: resolvedTools.effective,
    allowedChildren: resolvedAllowedChildren,
  };

  const reviewPolicy = policy.criticRequired
    ? materializePolicyModel(resolveExecutionPolicy({
        role: "critic",
        task: `Independently review the ${input.role === null ? "base" : input.role} handoff for major flaws and missing requirements.`,
        requirements: input.requirements,
        profileHint: {
          consequence: Math.max(2, policy.profile.consequence),
          uncertainty: Math.max(1, policy.profile.uncertainty),
          complexity: policy.profile.complexity,
          breadth: policy.profile.breadth,
          coupling: policy.profile.coupling,
          novelty: policy.profile.novelty,
        },
        cwd: ctx.cwd,
        config,
      }), ctx)
    : undefined;

  const timestamp = now();
  return {
    version: HANDLE_VERSION,
    id: randomUUID(),
    sessionId: parent?.sessionId ?? effectiveSessionId(ctx),
    ...(parent ? { parentId: parent.id } : {}),
    role: input.role,
    task: input.task,
    requirements: input.requirements,
    outputSchema: input.outputSchema,
    policy: resolvedPolicy,
    toolRequest: input.tools ?? null,
    resolvedTools,
    ...(reviewPolicy ? { reviewPolicy } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    attempts: [],
  };
}

// ── Foreground runner ───────────────────────────────────────────────────────

async function runForeground(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
  record: HandleRecord,
): Promise<HandleRecord> {
  let task = record.task;
  while (true) {
    const attemptNumber = record.attempts.length + 1;
    const runId = `phenix-${record.id}-a${attemptNumber}`;

    // Issue fresh v2 contract for this attempt.
    const issued = await createAttemptContract(record, task, ctx.cwd);
    const contractEnv = childContractEnv(
      issued.artifact.id,
      issued.capabilityToken,
      issued.phenixRunId,
      ctx.cwd,
    );

    record.attempts.push({
      number: attemptNumber,
      runId,
      phenixRunId: issued.phenixRunId,
      mode: "foreground",
      status: "running",
      startedAt: now(),
      contractId: issued.artifact.id,
      ...(task === record.task ? {} : { feedback: task }),
    });
    writeRecord(ctx.cwd, record);

    // Run producer with the generic bootstrap task.
    let children: RuntimeChildResult[];
    try {
      const producerParams = buildProducerSubagentParams(record);
      const raw = await backend.runForeground(
        runId,
        producerParams,
        signal,
        onUpdate,
        ctx,
        contractEnv,
      );
      children = backend.foregroundChildren(raw);
      recordChildSessions(record, children);
      writeRecord(ctx.cwd, record);
    } catch (error) {
      await cancelPendingContracts(latestAttempt(record));
      const attempt = latestAttempt(record);
      attempt.status = signal.aborted ? "cancelled" : "failed";
      attempt.endedAt = now();
      attempt.error = error instanceof Error ? error.message : String(error);
      record.status = signal.aborted ? "cancelled" : "failed";
      record.errors = [attempt.error];
      writeRecord(ctx.cwd, record);
      return record;
    }

    // Evaluate producer (schema from stored contract).
    const primary = await evaluateContractResult(
      latestAttempt(record).contractId,
      ctx.cwd,
    );

    // Run verification commands (only if producer succeeded).
    let verificationRuns: VerificationRun[] = [];
    let verifyRuns: string[] = [];
    let verificationOk = true;
    if (primary.ok) {
      verificationRuns = await runVerificationCommands(
        record.policy.verificationCommands,
        ctx.cwd,
        signal,
      );
      verificationRuns
        .filter((run) => run.status === "failed" || run.status === "timed-out" || run.status === "cancelled")
        .forEach(() => { verificationOk = false; });
      verifyRuns = verificationRuns.map(formatVerificationRun);
    }

    if (!primary.ok || !verificationOk) {
      const errors = !primary.ok ? primary.errors : verificationRuns
        .filter((run) => run.status === "failed" || run.status === "timed-out" || run.status === "cancelled")
        .map((run) => `runtime verification: ${formatVerificationRun(run)}`);
      const evaluation: Evaluation = {
        ok: false,
        errors,
        repairable: !signal.aborted && (!primary.ok ? (primary.contract === "invalid" || primary.contract === "missing") : true),
        verification: {
          runtimeChecks: [],
          verifyRuns,
          reviewFindings: [],
          contract: primary.contract,
        },
      };
      markEvaluation(ctx.cwd, record, evaluation);
      if (signal.aborted) {
        latestAttempt(record).status = "cancelled";
        record.status = "cancelled";
        record.errors = ["cancelled by parent"];
        writeRecord(ctx.cwd, record);
        return record;
      }
      if (!canRepair(record, evaluation)) {
        record.status = "failed";
        writeRecord(ctx.cwd, record);
        return record;
      }
      await cancelPendingContracts(latestAttempt(record));
      record.status = "running";
      task = repairTask(record, evaluation);
      writeRecord(ctx.cwd, record);
      continue;
    }

    // Run critic if required.
    if (record.reviewPolicy) {
      const criticIssued = await createAttemptContract(record, criticTask(record), ctx.cwd);
      const criticEnv = childContractEnv(
        criticIssued.artifact.id,
        criticIssued.capabilityToken,
        criticIssued.phenixRunId,
        ctx.cwd,
      );

      latestAttempt(record).criticContractId = criticIssued.artifact.id;
      writeRecord(ctx.cwd, record);

      let _criticChildren: RuntimeChildResult[];
      try {
        const criticParams = buildCriticSubagentParams(record);
        const criticResult = await backend.runForeground(
          `${runId}-critic`,
          criticParams,
          signal,
          onUpdate,
          ctx,
          criticEnv,
        );
        _criticChildren = backend.foregroundChildren(criticResult);
      } catch (error) {
        await cancelPendingContracts(latestAttempt(record));
        const attempt = latestAttempt(record);
        attempt.status = signal.aborted ? "cancelled" : "failed";
        attempt.endedAt = now();
        attempt.error = error instanceof Error ? error.message : String(error);
        record.status = signal.aborted ? "cancelled" : "failed";
        record.errors = [attempt.error];
        writeRecord(ctx.cwd, record);
        return record;
      }

      const critic = await evaluateContractResult(
        latestAttempt(record).criticContractId!,
        ctx.cwd,
      );

      if (!critic.ok) {
        const evaluation: Evaluation = {
          ok: false,
          errors: critic.errors.map((error) => `critic handoff: ${error}`),
          repairable: !signal.aborted && (critic.contract === "invalid" || critic.contract === "missing"),
          verification: {
            runtimeChecks: [],
            verifyRuns,
            reviewFindings: critic.errors,
            contract: "valid",
          },
        };
        markEvaluation(ctx.cwd, record, evaluation);
        if (signal.aborted) {
          latestAttempt(record).status = "cancelled";
          record.status = "cancelled";
          record.errors = ["cancelled by parent"];
          writeRecord(ctx.cwd, record);
          return record;
        }
        if (!canRepair(record, evaluation)) {
          record.status = "failed";
          writeRecord(ctx.cwd, record);
          return record;
        }
        await cancelPendingContracts(latestAttempt(record));
        record.status = "running";
        task = repairTask(record, evaluation);
        writeRecord(ctx.cwd, record);
        continue;
      }

      const criticValue = critic.value as CriticValue;
      const blockerFindings = criticValue.findings.filter(
        (finding) => finding.severity === "major" || finding.severity === "critical",
      );
      const reviewFindings = criticValue.findings.map(criticFindingText);
      const reviewErrors = [
        ...(criticValue.verdict === "reject" ? [`critic rejected the handoff: ${criticValue.summary}`] : []),
        ...blockerFindings.map((finding) => `critic blocker: ${criticFindingText(finding)}`),
        ...criticValue.missingRequirements.map((requirement) => `critic missing requirement: ${requirement}`),
      ];

      if (reviewErrors.length > 0) {
        const evaluation: Evaluation = {
          ok: false,
          errors: reviewErrors,
          repairable: true,
          review: {
            verdict: criticValue.verdict,
            summary: criticValue.summary,
            findings: criticValue.findings,
            missingRequirements: criticValue.missingRequirements,
          },
          verification: {
            runtimeChecks: [],
            verifyRuns,
            reviewFindings,
            contract: "valid",
          },
        };
        markEvaluation(ctx.cwd, record, evaluation);
        if (!canRepair(record, evaluation)) {
          record.status = "failed";
          writeRecord(ctx.cwd, record);
          return record;
        }
        await cancelPendingContracts(latestAttempt(record));
        record.status = "running";
        task = repairTask(record, evaluation);
        writeRecord(ctx.cwd, record);
        continue;
      }

      // Critic approved — full success.
      const successEvaluation: Evaluation = {
        ok: true,
        value: primary.value,
        errors: [],
        repairable: false,
        review: {
          verdict: criticValue.verdict,
          summary: criticValue.summary,
          findings: criticValue.findings,
          missingRequirements: criticValue.missingRequirements,
        },
        verification: {
          runtimeChecks: [],
          verifyRuns,
          reviewFindings,
          contract: "valid",
        },
      };
      markEvaluation(ctx.cwd, record, successEvaluation);
      return record;
    }

    // No critic required — producer-only success.
    const successEvaluation: Evaluation = {
      ok: true,
      value: primary.value,
      errors: [],
      repairable: false,
      verification: {
        runtimeChecks: [],
        verifyRuns: verificationRuns.map(formatVerificationRun),
        reviewFindings: [],
        contract: "valid",
      },
    };
    markEvaluation(ctx.cwd, record, successEvaluation);
    return record;
  }
}

// ── Background spawning ─────────────────────────────────────────────────────

async function spawnBackgroundAttempt(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  task: string,
): Promise<void> {
  const attemptNumber = record.attempts.length + 1;
  const requestId = `${record.id}-a${attemptNumber}`;
  const expectedRunId = `rpc-spawn-${requestId}`;

  // Issue fresh v2 contract for this background attempt.
  const issued = await createAttemptContract(record, task, ctx.cwd);
  const contractEnv = childContractEnv(
    issued.artifact.id,
    issued.capabilityToken,
    issued.phenixRunId,
    ctx.cwd,
  );

  const attempt: AttemptRecord = {
    number: attemptNumber,
    runId: expectedRunId,
    phenixRunId: issued.phenixRunId,
    mode: "background",
    status: "running",
    startedAt: now(),
    contractId: issued.artifact.id,
    ...(task === record.task ? {} : { feedback: task }),
  };
  record.attempts.push(attempt);
  writeRecord(ctx.cwd, record);

  try {
    const launched = await backend.spawnBackground(
      requestId,
      buildProducerSubagentParams(record),
      signal,
      contractEnv,
    );
    attempt.runId = launched.runId;
    attempt.asyncDir = launched.asyncDir;
    writeRecord(ctx.cwd, record);
  } catch (error) {
    attempt.status = "failed";
    attempt.endedAt = now();
    attempt.error = error instanceof Error ? error.message : String(error);
    record.status = "failed";
    record.errors = [attempt.error];
    writeRecord(ctx.cwd, record);
    throw error;
  }
}

async function resolveBackground(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  wait: boolean,
): Promise<HandleRecord> {
  while (record.status === "running") {
    const attempt = latestAttempt(record);
    let payload: AsyncResultPayload | undefined;
    try {
      payload = wait
        ? await backend.waitForResult(attempt.runId, signal, totalTimeoutMs(record))
        : backend.readResult(attempt.runId);
    } catch (error) {
      if (!wait) return record;
      attempt.status = signal.aborted ? "cancelled" : "failed";
      attempt.endedAt = now();
      attempt.error = error instanceof Error ? error.message : String(error);
      record.status = signal.aborted ? "cancelled" : "failed";
      record.errors = [attempt.error];
      writeRecord(ctx.cwd, record);
      return record;
    }

    if (!payload) return record;
    const children = backend.asyncResultChildren(payload);
    recordChildSessions(record, children);
    writeRecord(ctx.cwd, record);

    // Evaluate via contract store (same as foreground) — schema from stored artifact.
    const primary = await evaluateContractResult(
      attempt.contractId,
      ctx.cwd,
    );

    if (!primary.ok) {
      const evaluation: Evaluation = {
        ok: false,
        errors: primary.errors,
        repairable: primary.contract === "invalid" || primary.contract === "missing",
        verification: {
          runtimeChecks: [],
          verifyRuns: [],
          reviewFindings: [],
          contract: primary.contract,
        },
      };
      markEvaluation(ctx.cwd, record, evaluation);
      if (signal.aborted) {
        latestAttempt(record).status = "cancelled";
        record.status = "cancelled";
        record.errors = ["cancelled by parent"];
        writeRecord(ctx.cwd, record);
        return record;
      }
      if (!canRepair(record, evaluation)) {
        record.status = "failed";
        writeRecord(ctx.cwd, record);
        return record;
      }
      await cancelPendingContracts(latestAttempt(record));
      record.status = "running";
      await spawnBackgroundAttempt(
        backend,
        ctx,
        signal,
        record,
        repairTask(record, evaluation),
      );
      if (!wait) return record;
      continue;
    }

    // Background-mode success.
    const evaluation: Evaluation = {
      ok: true,
      value: primary.value,
      errors: [],
      repairable: false,
      verification: {
        runtimeChecks: [],
        verifyRuns: [],
        reviewFindings: [],
        contract: "valid",
      },
    };
    markEvaluation(ctx.cwd, record, evaluation);
    return record;
  }
  return record;
}

function totalTimeoutMs(record: HandleRecord): number {
  return record.policy.timeoutMs + (record.reviewPolicy?.timeoutMs ?? 0);
}

// ── Parent resolution ───────────────────────────────────────────────────────

function semanticParent(ctx: ExtensionContext, explicit: string | undefined): HandleRecord | undefined {
  if (explicit) return readRecord(ctx.cwd, effectiveSessionId(ctx), explicit);
  return currentParentRecord(ctx.cwd);
}

// ── Tree display ────────────────────────────────────────────────────────────

function treePayload(records: readonly HandleRecord[]): Record<string, unknown> {
  const children = new Map<string | undefined, HandleRecord[]>();
  for (const record of records) {
    const list = children.get(record.parentId) ?? [];
    list.push(record);
    children.set(record.parentId, list);
  }
  const build = (parentId: string | undefined): unknown[] =>
    (children.get(parentId) ?? []).map((record) => {
      const latest = record.attempts.at(-1);
      const primarySession = latest?.childSessions?.[0];
      const criticSession = latest?.childSessions?.[1];
      const helperChildren = criticSession ? [{
        id: `${record.id}:critic`,
        role: "critic",
        status: criticSession.status,
        sessionFile: criticSession.sessionFile,
        transcriptPath: criticSession.transcriptPath,
        internal: true,
        children: [],
      }] : [];
      return {
        id: record.id,
        role: record.role,
        status: record.status,
        attempts: record.attempts.length,
        createdAt: record.createdAt,
        sessionFile: primarySession?.sessionFile,
        transcriptPath: primarySession?.transcriptPath,
        children: [...helperChildren, ...build(record.id)],
      };
    });
  return { roots: build(undefined) };
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function registerPhenixSubagents(pi: ExtensionAPI): void {
  const backend = new SubagentBackend({ pi });

  const delegateTool: ToolDefinition<typeof DelegateParams, Record<string, unknown>> = {
    name: "phenix_delegate",
    label: "Phenix Delegate",
    description: [
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level.",
      "The output schema is enforced by the Phenix contract protocol.",
      "Tool access, verification commands, critic gates, retry limits, persistence, and model routing are runtime-owned; this tool intentionally exposes no override for them.",
      "Use mode=await by default. Background mode is available only from the root session and returns a persistent handle.",
    ].join(" "),
    parameters: DelegateParams,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as DelegateInput;

      // Validate role: must be null or a known agent kind.
      if (params.role !== null && !isAgentKind(params.role)) {
        return {
          content: [{ type: "text", text: `Unknown Phenix agent role: ${String(params.role)}` }],
          isError: true,
          details: { status: "failed" },
        };
      }

      try {
        assertOutputSchema(params.outputSchema);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
          details: { status: "failed" },
        };
      }

      // Check child authorization.
      if (!childAllowedByContext(params.role)) {
        const callerContext = getRuntimeContext();
        const ctxRole = callerContext?.kind === "child"
          ? callerContext.contract.identity.role : "root";
        return {
          content: [{ type: "text", text: `${String(ctxRole)} may not spawn ${String(params.role)}; allowed child roles are fixed by the runtime.` }],
          isError: true,
          details: { status: "failed" },
        };
      }

      const callerContext2 = getRuntimeContext();
      const callerRole = callerContext2?.kind === "child"
        ? callerContext2.contract.identity.role : "root";

      const mode = params.mode ?? "await";
      if (callerRole !== "root" && mode === "background") {
        return {
          content: [{ type: "text", text: "Nested background delegation is disabled. Child agents must use structured foreground delegation so descendants remain owned and joined." }],
          isError: true,
          details: { status: "failed" },
        };
      }

      const parent = semanticParent(ctx, params.parent);
      if (params.parent && !parent) {
        return {
          content: [{ type: "text", text: `Semantic parent handle not found: ${params.parent}` }],
          isError: true,
          details: { status: "failed" },
        };
      }
      if (parent && callerRole === "root" && params.role !== null && !parent.policy.allowedChildren.includes(params.role)) {
        return {
          content: [{ type: "text", text: `${parent.role} handle ${parent.id} may not own a ${String(params.role)} child.` }],
          isError: true,
          details: { status: "failed" },
        };
      }

      const record = createRecord(
        ctx,
        {
          role: params.role,
          task: params.task.trim(),
          outputSchema: params.outputSchema,
          requirements: params.requirements ?? [],
          tools: params.tools,
          profile: params.profile,
          mode,
          parent: params.parent,
        },
        parent,
      );
      writeRecord(ctx.cwd, record);

      if (mode === "background") {
        try {
          await spawnBackgroundAttempt(backend, ctx, signal, record, record.task);
        } catch {
          return toolResult(record);
        }
        return toolResult(record);
      }

      const finished = await runForeground(
        backend,
        ctx,
        signal,
        onUpdate as ((result: AgentToolResult<Details>) => void) | undefined,
        record,
      );
      return toolResult(finished);
    },
  };

  const agentTool: ToolDefinition<typeof AgentParams, Record<string, unknown>> = {
    name: "phenix_agent",
    label: "Phenix Agent",
    description: "Inspect, await, poll, cancel, or display the persistent tree of Phenix subagent handles.",
    parameters: AgentParams,
    async execute(_id, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as { action: "await" | "poll" | "cancel" | "inspect" | "tree"; id?: string };
      if (params.action === "tree") {
        const payload = treePayload(listRecords(ctx.cwd, effectiveSessionId(ctx)));
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      }
      if (!params.id) {
        return {
          content: [{ type: "text", text: `phenix_agent action '${params.action}' requires id` }],
          isError: true,
          details: { status: "failed" },
        };
      }

      const record = readRecord(ctx.cwd, effectiveSessionId(ctx), params.id);
      if (!record) {
        return {
          content: [{ type: "text", text: `Phenix handle not found: ${params.id}` }],
          isError: true,
          details: { status: "failed" },
        };
      }

      if (params.action === "inspect") return toolResult(record);
      if (params.action === "cancel") {
        if (!TERMINAL_STATES.has(record.status)) {
          const attempt = latestAttempt(record);
          try {
            await backend.interrupt(attempt.runId, signal);
          } catch {
            await backend.stop(attempt.runId, signal).catch(() => undefined);
          }
          await cancelPendingContracts(attempt);
          attempt.status = "cancelled";
          attempt.endedAt = now();
          record.status = "cancelled";
          record.errors = ["cancelled by parent"];
          writeRecord(ctx.cwd, record);
        }
        return toolResult(record);
      }

      if (record.status === "running" && latestAttempt(record).mode === "background") {
        await resolveBackground(backend, ctx, signal, record, params.action === "await");
      }
      return toolResult(record);
    },
  };

  pi.registerTool(delegateTool);
  pi.registerTool(agentTool);
}
