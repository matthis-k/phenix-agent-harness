import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
  type RuntimeAcceptanceLedger,
  type RuntimeChildResult,
} from "./backend.ts";
import {
  assertOutputSchema,
  validateContract,
  type JsonSchema,
} from "./contracts.ts";
import {
  childAllowed,
  isAgentKind,
  loadPolicyConfig,
  resolveExecutionPolicy,
  roleFromEnvironment,
  toolAllowed,
  type AgentKind,
  type ProfileHint,
  type ResolvedExecutionPolicy,
} from "./policy.ts";
import {
  runVerificationCommands,
  type VerificationRun,
} from "./verification.ts";

const HANDLE_VERSION = 1;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const CRITIC_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "missingRequirements"],
  properties: {
    verdict: { enum: ["approve", "reject"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "description", "evidence"],
        properties: {
          severity: { enum: ["minor", "major", "critical"] },
          description: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
          requirement: { type: "string" },
        },
      },
    },
    missingRequirements: { type: "array", items: { type: "string", minLength: 1 } },
  },
};
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const ACCEPTANCE_RANK: Record<string, number> = {
  "not-required": 0,
  claimed: 0,
  attested: 1,
  checked: 2,
  verified: 3,
  reviewed: 4,
  accepted: 5,
  rejected: -1,
};

interface AttemptRecord {
  readonly number: number;
  runId: string;
  readonly mode: "foreground" | "background";
  readonly startedAt: string;
  asyncDir?: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  feedback?: string;
  error?: string;
  childSessions?: Array<{
    readonly role: string;
    readonly status: "completed" | "failed";
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  }>;
}

interface HandleRecord {
  readonly version: typeof HANDLE_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly parentId?: string;
  readonly role: AgentKind;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly policy: ResolvedExecutionPolicy;
  readonly reviewPolicy?: ResolvedExecutionPolicy;
  readonly createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  attempts: AttemptRecord[];
  value?: unknown;
  errors?: string[];
  verification?: VerificationSummary;
  review?: {
    readonly verdict: "approve" | "reject";
    readonly summary: string;
    readonly findings: readonly CriticFinding[];
    readonly missingRequirements: readonly string[];
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  };
}

interface CriticFinding {
  readonly severity: "minor" | "major" | "critical";
  readonly description: string;
  readonly evidence: string;
  readonly requirement?: string;
}

interface CriticValue {
  readonly verdict: "approve" | "reject";
  readonly summary: string;
  readonly findings: readonly CriticFinding[];
  readonly missingRequirements: readonly string[];
}

interface VerificationSummary {
  readonly acceptanceStatus?: string;
  readonly runtimeChecks: readonly string[];
  readonly verifyRuns: readonly string[];
  readonly reviewFindings: readonly string[];
  readonly contract: "valid" | "invalid" | "missing";
}

interface Evaluation {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly errors: readonly string[];
  readonly repairable: boolean;
  readonly verification: VerificationSummary;
  readonly review?: HandleRecord["review"];
}

interface DelegateInput {
  readonly role: AgentKind;
  readonly task: string;
  readonly outputSchema: JsonSchema;
  readonly requirements: readonly string[];
  readonly profile?: ProfileHint;
  readonly mode: "await" | "background";
  readonly parent?: string;
}

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

const DelegateParams = Type.Object(
  {
    role: Type.String({ enum: [...(["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"] as const)] }),
    task: Type.String({ minLength: 1 }),
    outputSchema: JsonSchemaObject,
    requirements: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
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

function now(): string {
  return new Date().toISOString();
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "ephemeral";
}

function currentParentRecord(cwd: string): HandleRecord | undefined {
  for (const runId of [
    process.env.PI_SUBAGENT_RUN_ID,
    process.env.PI_SUBAGENT_PARENT_RUN_ID,
    process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID,
  ]) {
    const record = findByRunId(cwd, runId);
    if (record) return record;
  }
  return undefined;
}

function effectiveSessionId(ctx: ExtensionContext): string {
  return currentParentRecord(ctx.cwd)?.sessionId ?? sessionId(ctx);
}

function recordsRoot(cwd: string): string {
  return path.join(findProjectRoot(cwd), ".phenix-agent-state", "subagents");
}

function recordPath(cwd: string, session: string, id: string): string {
  return path.join(recordsRoot(cwd), sanitize(session), `${sanitize(id)}.json`);
}

function writeRecord(cwd: string, record: HandleRecord): void {
  record.updatedAt = now();
  const target = recordPath(cwd, record.sessionId, record.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function readRecord(cwd: string, session: string, id: string): HandleRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(recordPath(cwd, session, id), "utf-8")) as HandleRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function listRecords(cwd: string, session?: string): HandleRecord[] {
  const root = recordsRoot(cwd);
  const sessionDirs = session ? [sanitize(session)] : safeReadDir(root);
  const records: HandleRecord[] = [];
  for (const sessionDir of sessionDirs) {
    const dir = path.join(root, sessionDir);
    for (const file of safeReadDir(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as HandleRecord;
        if (record.version === HANDLE_VERSION) records.push(record);
      } catch {
        // A partially written or manually damaged record is ignored; atomic writes prevent normal partial files.
      }
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findByRunId(cwd: string, runId: string | undefined): HandleRecord | undefined {
  if (!runId) return undefined;
  return listRecords(cwd).find((record) => record.attempts.some((attempt) => attempt.runId === runId));
}

function latestAttempt(record: HandleRecord): AttemptRecord {
  const attempt = record.attempts.at(-1);
  if (!attempt) throw new Error(`handle ${record.id} has no attempts`);
  return attempt;
}

function recordChildSessions(record: HandleRecord, children: readonly RuntimeChildResult[]): void {
  latestAttempt(record).childSessions = children.map((child, index) => ({
    role: child.agent ?? (index === 0 ? record.policy.agent : record.reviewPolicy?.agent ?? `child-${index}`),
    status: child.success === false || (child.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0)
      ? "failed"
      : "completed",
    ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
    ...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
  }));
}

function expectedAcceptanceRank(policy: ResolvedExecutionPolicy): number {
  return ACCEPTANCE_RANK[policy.expectedAcceptance] ?? 0;
}

function compactOutput(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function evaluateAcceptance(
  acceptance: RuntimeAcceptanceLedger | undefined,
  expectedRank: number,
): {
  errors: string[];
  runtimeChecks: string[];
  verifyRuns: string[];
  reviewFindings: string[];
  status?: string;
} {
  const errors: string[] = [];
  const runtimeChecks: string[] = [];
  const verifyRuns: string[] = [];
  const reviewFindings: string[] = [];
  const status = acceptance?.status;

  if (!status) {
    errors.push("runtime acceptance ledger is missing");
  } else if ((ACCEPTANCE_RANK[status] ?? -1) < expectedRank) {
    errors.push(`runtime acceptance '${status}' is below required level`);
  }

  if (acceptance?.childReportParseError) {
    errors.push(`acceptance report format: ${acceptance.childReportParseError}`);
  }

  for (const check of acceptance?.runtimeChecks ?? []) {
    if (check.status === "failed") {
      const text = `${check.id ?? "runtime-check"}: ${check.message ?? "failed"}`;
      runtimeChecks.push(text);
      errors.push(text);
    }
  }

  // Phenix does not put authoritative verification or review in a model-owned
  // acceptance report. These fields are retained only to surface failures from
  // pi-subagents itself if a future backend version emits them unexpectedly.
  for (const run of acceptance?.verifyRuns ?? []) {
    if (run.status === "passed" || run.status === "allowed-failure") continue;
    const output = compactOutput(run.stderr) ?? compactOutput(run.stdout);
    const text = [
      `${run.id ?? "verification"}: ${run.status ?? "failed"}`,
      run.exitCode !== undefined ? `exit ${String(run.exitCode)}` : undefined,
      output,
    ].filter(Boolean).join("; ");
    verifyRuns.push(text);
    errors.push(text);
  }

  return { errors, runtimeChecks, verifyRuns, reviewFindings, ...(status ? { status } : {}) };
}

function evaluateStructuredChild(
  schema: JsonSchema,
  policy: ResolvedExecutionPolicy,
  child: RuntimeChildResult | undefined,
): Evaluation {
  const errors: string[] = [];
  if (!child) {
    return {
      ok: false,
      errors: ["expected child result is missing"],
      repairable: true,
      verification: {
        runtimeChecks: [],
        verifyRuns: [],
        reviewFindings: [],
        contract: "missing",
      },
    };
  }

  const executionFailed = child.success === false || (child.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0);
  if (executionFailed) {
    errors.push(child.error ?? compactOutput(child.finalOutput ?? child.output) ?? `child exited with ${String(child.exitCode)}`);
  }

  let contractState: VerificationSummary["contract"] = "missing";
  if (child.structuredOutput === undefined) {
    errors.push("structured handoff is missing");
  } else {
    const validation = validateContract(schema, child.structuredOutput);
    if (validation.ok) {
      contractState = "valid";
    } else if ("summary" in validation) {
      contractState = "invalid";
      errors.push(`structured handoff format: ${validation.summary}`);
    }
  }

  const acceptance = evaluateAcceptance(
    child.acceptance,
    expectedAcceptanceRank(policy),
  );
  errors.push(...acceptance.errors);

  return {
    ok: errors.length === 0,
    ...(errors.length === 0 ? { value: child.structuredOutput } : {}),
    errors,
    repairable: contractState !== "valid" || acceptance.errors.length > 0,
    verification: {
      acceptanceStatus: acceptance.status,
      runtimeChecks: acceptance.runtimeChecks,
      verifyRuns: acceptance.verifyRuns,
      reviewFindings: acceptance.reviewFindings,
      contract: contractState,
    },
  };
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

async function evaluateAttempt(
  record: HandleRecord,
  children: readonly RuntimeChildResult[],
  cwd: string,
  signal: AbortSignal,
): Promise<Evaluation> {
  const primary = evaluateStructuredChild(record.outputSchema, record.policy, children[0]);
  if (!primary.ok) return primary;

  const verificationRuns = await runVerificationCommands(
    record.policy.verificationCommands,
    cwd,
    signal,
  );
  const verificationErrors = verificationRuns
    .filter((run) => run.status === "failed" || run.status === "timed-out" || run.status === "cancelled")
    .map(formatVerificationRun);
  const verifyRuns = [
    ...primary.verification.verifyRuns,
    ...verificationRuns.map(formatVerificationRun),
  ];
  if (verificationErrors.length > 0) {
    return {
      ok: false,
      errors: verificationErrors.map((error) => `runtime verification: ${error}`),
      repairable: !signal.aborted,
      verification: {
        ...primary.verification,
        verifyRuns,
      },
    };
  }

  if (!record.reviewPolicy) {
    return {
      ...primary,
      verification: {
        ...primary.verification,
        verifyRuns,
      },
    };
  }

  const criticChild = children[1];
  const critic = evaluateStructuredChild(
    CRITIC_OUTPUT_SCHEMA,
    record.reviewPolicy,
    criticChild,
  );
  if (!critic.ok) {
    return {
      ok: false,
      errors: critic.errors.map((error) => `critic handoff: ${error}`),
      repairable: critic.repairable,
      verification: {
        ...primary.verification,
        verifyRuns,
        reviewFindings: critic.errors,
      },
    };
  }

  const value = critic.value as CriticValue;
  const blockerFindings = value.findings.filter(
    (finding) => finding.severity === "major" || finding.severity === "critical",
  );
  const reviewFindings = value.findings.map(criticFindingText);
  const reviewErrors = [
    ...(value.verdict === "reject" ? [`critic rejected the handoff: ${value.summary}`] : []),
    ...blockerFindings.map((finding) => `critic blocker: ${criticFindingText(finding)}`),
    ...value.missingRequirements.map((requirement) => `critic missing requirement: ${requirement}`),
  ];
  const review: NonNullable<HandleRecord["review"]> = {
    verdict: value.verdict,
    summary: value.summary,
    findings: value.findings,
    missingRequirements: value.missingRequirements,
    ...(criticChild?.sessionFile ? { sessionFile: criticChild.sessionFile } : {}),
    ...(criticChild?.transcriptPath ? { transcriptPath: criticChild.transcriptPath } : {}),
  };

  if (reviewErrors.length > 0) {
    return {
      ok: false,
      errors: reviewErrors,
      repairable: true,
      review,
      verification: {
        ...primary.verification,
        verifyRuns,
        reviewFindings,
      },
    };
  }

  return {
    ok: true,
    value: primary.value,
    errors: [],
    repairable: false,
    review,
    verification: {
      ...primary.verification,
      verifyRuns,
      reviewFindings,
    },
  };
}

function repairTask(record: HandleRecord, evaluation: Evaluation): string {
  const numbered = evaluation.errors.map((error, index) => `${index + 1}. ${error}`).join("\n");
  return [
    record.task,
    "",
    "## Runtime repair request",
    "The previous handoff was rejected by authoritative runtime validation. Continue from the current workspace state and correct the work.",
    "",
    numbered,
    "",
    "The runtime will rerun the same structural contract, verification commands, and critic gate. Do not modify verification configuration or merely claim that checks passed.",
    "Finish by calling structured_output with a value matching the original schema.",
  ].join("\n");
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
    "Primary structured handoff:",
    "{outputs.primary}",
    "",
    "Return the runtime-provided critic schema using structured_output.",
  ].join("\n");
}

function buildSubagentParams(
  record: HandleRecord,
  task: string,
): SubagentParamsLike {
  const primaryStep: Record<string, unknown> = {
    agent: record.policy.agent,
    task,
    as: "primary",
    outputSchema: record.outputSchema,
    acceptance: record.policy.acceptance,
    toolBudget: record.policy.toolBudget,
    phase: record.role,
    label: `${record.role} handoff`,
    ...(applyThinking(record.policy.model, record.policy.thinking)
      ? { model: applyThinking(record.policy.model, record.policy.thinking) }
      : {}),
  };
  const chain: Record<string, unknown>[] = [primaryStep];

  if (record.reviewPolicy) {
    chain.push({
      agent: record.reviewPolicy.agent,
      task: criticTask(record),
      as: "critic",
      outputSchema: CRITIC_OUTPUT_SCHEMA,
      acceptance: record.reviewPolicy.acceptance,
      toolBudget: record.reviewPolicy.toolBudget,
      phase: "critic",
      label: `${record.role} independent critic`,
      ...(applyThinking(record.reviewPolicy.model, record.reviewPolicy.thinking)
        ? { model: applyThinking(record.reviewPolicy.model, record.reviewPolicy.thinking) }
        : {}),
    });
  }

  return {
    chain: chain as never,
    context: "fresh",
    async: false,
    clarify: false,
    artifacts: true,
    includeProgress: false,
    timeoutMs: record.policy.timeoutMs + (record.reviewPolicy?.timeoutMs ?? 0),
    turnBudget: {
      maxTurns: record.policy.turnBudget.maxTurns + (record.reviewPolicy?.turnBudget.maxTurns ?? 0),
      graceTurns: Math.max(record.policy.turnBudget.graceTurns, record.reviewPolicy?.turnBudget.graceTurns ?? 0),
    },
    agentScope: "both",
  };
}

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

function createRecord(
  ctx: ExtensionContext,
  input: DelegateInput,
  parent: HandleRecord | undefined,
): HandleRecord {
  const config = loadPolicyConfig();
  const policy = materializePolicyModel(resolveExecutionPolicy({
    role: input.role,
    task: input.task,
    requirements: input.requirements,
    profileHint: input.profile,
    cwd: ctx.cwd,
    config,
  }), ctx);
  const reviewPolicy = policy.criticRequired
    ? materializePolicyModel(resolveExecutionPolicy({
        role: "critic",
        task: `Independently review the ${input.role} handoff for major flaws and missing requirements.`,
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
    policy,
    ...(reviewPolicy ? { reviewPolicy } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    attempts: [],
  };
}

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
    record.attempts.push({
      number: attemptNumber,
      runId,
      mode: "foreground",
      status: "running",
      startedAt: now(),
      ...(task === record.task ? {} : { feedback: task }),
    });
    writeRecord(ctx.cwd, record);

    let children: RuntimeChildResult[];
    try {
      const raw = await backend.runForeground(
        runId,
        buildSubagentParams(record, task),
        signal,
        onUpdate,
        ctx,
      );
      children = backend.foregroundChildren(raw);
      recordChildSessions(record, children);
      writeRecord(ctx.cwd, record);
    } catch (error) {
      const attempt = latestAttempt(record);
      attempt.status = signal.aborted ? "cancelled" : "failed";
      attempt.endedAt = now();
      attempt.error = error instanceof Error ? error.message : String(error);
      record.status = signal.aborted ? "cancelled" : "failed";
      record.errors = [attempt.error];
      writeRecord(ctx.cwd, record);
      return record;
    }

    const evaluation = await evaluateAttempt(record, children, ctx.cwd, signal);
    markEvaluation(ctx.cwd, record, evaluation);
    if (signal.aborted) {
      latestAttempt(record).status = "cancelled";
      record.status = "cancelled";
      record.errors = ["cancelled by parent"];
      writeRecord(ctx.cwd, record);
      return record;
    }
    if (evaluation.ok) return record;
    if (!canRepair(record, evaluation)) {
      record.status = "failed";
      writeRecord(ctx.cwd, record);
      return record;
    }

    record.status = "running";
    task = repairTask(record, evaluation);
    writeRecord(ctx.cwd, record);
  }
}

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
  const attempt: AttemptRecord = {
    number: attemptNumber,
    runId: expectedRunId,
    mode: "background",
    status: "running",
    startedAt: now(),
    ...(task === record.task ? {} : { feedback: task }),
  };
  record.attempts.push(attempt);
  writeRecord(ctx.cwd, record);

  try {
    const launched = await backend.spawnBackground(
      requestId,
      buildSubagentParams(record, task),
      signal,
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
    const evaluation = await evaluateAttempt(record, children, ctx.cwd, signal);
    markEvaluation(ctx.cwd, record, evaluation);
    if (signal.aborted) {
      latestAttempt(record).status = "cancelled";
      record.status = "cancelled";
      record.errors = ["cancelled by parent"];
      writeRecord(ctx.cwd, record);
      return record;
    }
    if (evaluation.ok) return record;
    if (!canRepair(record, evaluation)) {
      record.status = "failed";
      writeRecord(ctx.cwd, record);
      return record;
    }

    record.status = "running";
    await spawnBackgroundAttempt(
      backend,
      ctx,
      signal,
      record,
      repairTask(record, evaluation),
    );
    if (!wait) return record;
  }
  return record;
}

function totalTimeoutMs(record: HandleRecord): number {
  return record.policy.timeoutMs + (record.reviewPolicy?.timeoutMs ?? 0);
}

function semanticParent(ctx: ExtensionContext, explicit: string | undefined): HandleRecord | undefined {
  if (explicit) return readRecord(ctx.cwd, effectiveSessionId(ctx), explicit);
  return currentParentRecord(ctx.cwd);
}

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

function registerToolGuard(pi: ExtensionAPI): void {
  const onRuntimeEvent = pi.on as unknown as (
    event: string,
    handler: (event: { toolName?: string }) => unknown,
  ) => void;
  onRuntimeEvent("tool_call", (event) => {
    const toolName = event.toolName ?? "unknown";
    const role = roleFromEnvironment();
    if (toolName === "subagent") {
      return {
        block: true,
        reason: "Raw subagent calls are disabled by Phenix. Use phenix_delegate so model/thinking selection, tool policy, persistence, structured contracts, and verification remain runtime-owned.",
      };
    }
    if (!toolAllowed(role, toolName)) {
      return {
        block: true,
        reason: `Tool '${toolName}' is outside the runtime allowlist for ${role}. Complete the task with the authorized tools or report the missing capability to the supervisor.`,
      };
    }
    return undefined;
  });
}

export default function registerPhenixSubagents(pi: ExtensionAPI): void {
  registerToolGuard(pi);
  const backend = new SubagentBackend({ pi });

  const delegateTool: ToolDefinition<typeof DelegateParams, Record<string, unknown>> = {
    name: "phenix_delegate",
    label: "Phenix Delegate",
    description: [
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level.",
      "The output schema is enforced by the child structured_output tool and revalidated by Phenix.",
      "Tool access, verification commands, critic gates, retry limits, persistence, and model routing are runtime-owned; this tool intentionally exposes no override for them.",
      "Use mode=await by default. Background mode is available only from the root session and returns a persistent handle.",
    ].join(" "),
    parameters: DelegateParams,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as DelegateInput;
      if (!isAgentKind(params.role)) {
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

      const callerRole = roleFromEnvironment();
      if (!childAllowed(callerRole, params.role)) {
        return {
          content: [{ type: "text", text: `${callerRole} may not spawn ${params.role}; allowed child roles are fixed by the runtime.` }],
          isError: true,
          details: { status: "failed" },
        };
      }

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
      if (parent && callerRole === "root" && !childAllowed(parent.role, params.role)) {
        return {
          content: [{ type: "text", text: `${parent.role} handle ${parent.id} may not own a ${params.role} child.` }],
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

  // Register structured_output at extension init, BEFORE the prompt-runtime
  // extension (loaded via --extension). Our TypeBox registration wins;
  // the prompt-runtime's duplicate (plain JSON parameters, silently ignored)
  // gets a benign conflict error that doesn't prevent our registration from
  // working.
  (pi.registerTool as unknown as (tool: Record<string, unknown>) => void)({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Submit the required final structured output for this subagent step. This terminates the step.",
    parameters: Type.Object({
      value: Type.Unsafe({}),
    }, { additionalProperties: false }) as never,
    execute: async (_id: string, params: { value: unknown }) => {
      const structuredOutputPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
      const structuredSchemaPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
      if (!structuredOutputPath || !structuredSchemaPath) {
        return {
          content: [{ type: "text" as const, text: "Structured output: env vars not set — cannot capture output." }],
          isError: true,
        };
      }
      try {
        fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
        fs.writeFileSync(structuredOutputPath, JSON.stringify(params.value), {
          mode: 0o600,
        });
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: `Failed to write structured output: ${error instanceof Error ? error.message : String(error)}` },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: "Structured output captured." }],
        details: { path: structuredOutputPath },
        terminate: true,
      };
    },
  });
}
