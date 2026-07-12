import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ContractArtifact } from "./contract.ts";
import type {
  AttemptRecord,
  CriticValue,
  Evaluation,
  HandleRecord,
  VerificationSummary,
} from "./handle-types.ts";
import {
  createAttemptContract,
  evaluateContractResult,
  repairTask,
  childContractEnv,
} from "./handle-evaluation.ts";
import {
  latestAttempt,
  now,
  writeRecord,
} from "./handle-store.ts";
import {
  SubagentBackend,
  type SpawnedChild,
} from "./backend.ts";
import {
  materializeContractAgent,
  releaseMaterializedAgent,
} from "./contract-agent-materializer.ts";
import {
  CRITIC_OUTPUT_SCHEMA,
} from "./handle-types.ts";

// ── Attempt phases ──────────────────────────────────────────────────────────

type AttemptPhase =
  | "spawning-producer"
  | "producer-running"
  | "evaluating-producer"
  | "verifying"
  | "spawning-critic"
  | "critic-running"
  | "evaluating-critic"
  | "repair-pending"
  | "completed"
  | "failed"
  | "cancelled";

// ── Internal state tracker ──────────────────────────────────────────────────

interface RunnerState {
  phase: AttemptPhase;
  spawnedChild?: SpawnedChild;
  materializedProducer?: ReturnType<typeof materializeContractAgent>;
  materializedCritic?: ReturnType<typeof materializeContractAgent>;
  issuedContract?: Awaited<ReturnType<typeof createAttemptContract>>;
  criticContract?: Awaited<ReturnType<typeof createAttemptContract>>;
}

// ── Run result ──────────────────────────────────────────────────────────────

export interface AttemptRunResult {
  readonly phase: AttemptPhase;
  readonly evaluation?: Evaluation;
  readonly record: HandleRecord;
}

// ── Attempt runner ──────────────────────────────────────────────────────────

export async function runAttempt(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
): Promise<AttemptRunResult> {
  const state: RunnerState = { phase: "spawning-producer" };

  try {
    return await runProducerCycle(backend, ctx, signal, record, state);
  } catch (error) {
    if (signal.aborted) {
      record.status = "cancelled";
      record.errors = ["cancelled by parent"];
      writeRecord(ctx.cwd, record);
      return { phase: "cancelled", record };
    }
    throw error;
  }
}

async function runProducerCycle(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  state: RunnerState,
): Promise<AttemptRunResult> {
  // ── Create attempt record ──────────────────────────────────────────────
  const attemptNumber = record.attempts.length + 1;
  const handleId = `${record.id}-attempt-${attemptNumber}`;

  // ── Issue producer contract ───────────────────────────────────────────
  state.issuedContract = await createAttemptContract({
    spec: record.producerSpec,
    assignment: record.assignment,
    identity: {
      handleId,
      parentHandleId: record.id,
    },
    cwd: ctx.cwd,
  });

  const phenixRunId = state.issuedContract.phenixRunId;
  const contractId = state.issuedContract.artifact.id;
  const capabilityToken = state.issuedContract.capabilityToken;

  // ── Persist the attempt record ────────────────────────────────────────
  const attempt: AttemptRecord = {
    number: attemptNumber,
    runId: "",
    phenixRunId,
    mode: record.status === "running" ? latestAttempt(record)?.mode ?? "foreground" : "foreground",
    startedAt: now(),
    contractId,
    status: "running",
  };
  record.attempts.push(attempt);
  writeRecord(ctx.cwd, record);

  // ── Materialize contract agent ────────────────────────────────────────
  const materialized = materializeContractAgent(state.issuedContract.artifact);
  state.materializedProducer = materialized;

  // ── Build environment ─────────────────────────────────────────────────
  const env = childContractEnv(
    contractId,
    capabilityToken,
    phenixRunId,
    ctx.cwd,
  );

  // ── Build subagent params from contract ───────────────────────────────
  const params = buildSubagentParams(
    state.issuedContract.artifact,
    materialized.runtimeName,
  );

  try {
    state.phase = "spawning-producer";

    // ── Spawn child ─────────────────────────────────────────────────────
    const child = await backend.spawn(
      {
        requestId: handleId,
        params,
        environment: env,
        extraAgentDirectory: materialized.leaseDir,
      },
      signal,
    );
    state.spawnedChild = child;

    // Record the run ID.
    attempt.runId = child.runId;
    attempt.asyncDir = child.asyncDir;
    writeRecord(ctx.cwd, record);

    state.phase = "producer-running";

    // Release materialized lease (child has been spawned).
    if (state.materializedProducer) {
      releaseMaterializedAgent(state.materializedProducer);
      state.materializedProducer = undefined;
    }

    // ── Wait for result ─────────────────────────────────────────────────
    const result = await backend.waitForResult(
      child.runId,
      signal,
      state.issuedContract.artifact.runtime.timeoutMs + 30_000,
    );

    // ── Evaluate producer result ────────────────────────────────────────
    state.phase = "evaluating-producer";

    const evaluation = await evaluateProducerResult(
      record,
      state.issuedContract.artifact,
      result,
      ctx.cwd,
      signal,
    );

    attempt.endedAt = now();

    if (!evaluation.ok) {
      // ── Check if repairable ──────────────────────────────────────────
      if (evaluation.repairable && attemptNumber <= record.producerSpec.maxRepairAttempts + 1) {
        state.phase = "repair-pending";
        attempt.feedback = repairTask(record, evaluation);
        attempt.status = "failed";
        if (!record.errors) record.errors = [];
        record.errors = [...record.errors, ...evaluation.errors];
        writeRecord(ctx.cwd, record);
        return await runProducerCycle(backend, ctx, signal, record, state);
      }

      // Not repairable — fail.
      attempt.status = "failed";
      attempt.error = evaluation.errors.join(" | ");
      record.status = "failed";
      record.errors = [...evaluation.errors];
      writeRecord(ctx.cwd, record);
      return { phase: "failed", evaluation, record };
    }

    // Producer succeeded. Record the value.
    attempt.status = "completed";
    record.value = evaluation.value;

    // ── Run critic if required ──────────────────────────────────────────
    if (record.producerSpec.criticRequired && record.criticSpec) {
      return await runCriticCycle(backend, ctx, signal, record, state, evaluation);
    }

    // No critic needed — mark complete.
    record.status = "completed";
    writeRecord(ctx.cwd, record);
    return { phase: "completed", evaluation, record };
  } catch (error) {
    // Clean up materialized lease on error.
    if (state.materializedProducer) {
      releaseMaterializedAgent(state.materializedProducer);
    }
    throw error;
  }
}

async function runCriticCycle(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  state: RunnerState,
  producerEvaluation: Evaluation,
): Promise<AttemptRunResult> {
  if (!record.criticSpec) {
    record.status = "completed";
    writeRecord(ctx.cwd, record);
    return { phase: "completed", evaluation: producerEvaluation, record };
  }

  const criticPick = record.criticSpec;
  const parentRunId = state.issuedContract?.phenixRunId;
  const attempt = latestAttempt(record);
  const criticHandleId = `${record.id}-critic-attempt-${attempt.number}`;

  // ── Issue critic contract ─────────────────────────────────────────────
  state.criticContract = await createAttemptContract({
    spec: criticPick,
    assignment: {
      task: buildCriticTask(record, producerEvaluation),
      requirements: record.assignment.requirements,
      outputSchema: CRITIC_OUTPUT_SCHEMA,
    },
    identity: {
      handleId: criticHandleId,
      parentHandleId: record.id,
      parentRunId,
    },
    cwd: ctx.cwd,
  });

  const criticContractId = state.criticContract.artifact.id;
  const criticCapabilityToken = state.criticContract.capabilityToken;
  const criticRunId = state.criticContract.phenixRunId;

  attempt.criticContractId = criticContractId;
  writeRecord(ctx.cwd, record);

  // ── Materialize critic agent ──────────────────────────────────────────
  const materialized = materializeContractAgent(state.criticContract.artifact);
  state.materializedCritic = materialized;

  const env = childContractEnv(
    criticContractId,
    criticCapabilityToken,
    criticRunId,
    ctx.cwd,
  );

  const params = buildSubagentParams(
    state.criticContract.artifact,
    materialized.runtimeName,
  );

  try {
    state.phase = "spawning-critic";

    const child = await backend.spawn(
      {
        requestId: criticHandleId,
        params,
        environment: env,
        extraAgentDirectory: materialized.leaseDir,
      },
      signal,
    );

    state.phase = "critic-running";

    // Release materialized critic lease.
    if (state.materializedCritic) {
      releaseMaterializedAgent(state.materializedCritic);
      state.materializedCritic = undefined;
    }

    const result = await backend.waitForResult(
      child.runId,
      signal,
      state.criticContract.artifact.runtime.timeoutMs + 30_000,
    );

    state.phase = "evaluating-critic";

    // ── Evaluate critic result ─────────────────────────────────────────
    const criticEval = await evaluateContractResult(criticContractId, ctx.cwd);

    if (!criticEval.ok || !criticEval.value) {
      attempt.status = "failed";
      attempt.error = `Critic evaluation failed: ${criticEval.errors.join("; ")}`;
      record.status = "failed";
      record.errors = [...criticEval.errors];
      writeRecord(ctx.cwd, record);
      return { phase: "failed", evaluation: producerEvaluation, record };
    }

    const criticResult = criticEval.value as CriticValue;

    if (criticResult.verdict === "reject") {
      const evaluation: Evaluation = {
        ok: false,
        errors: [
          `Critic rejected: ${criticResult.summary}`,
          ...criticResult.findings.map(
            (f) => `[${f.severity}] ${f.description}`,
          ),
        ],
        repairable: true,
        verification: producerEvaluation.verification,
        review: {
          verdict: "reject",
          summary: criticResult.summary,
          findings: criticResult.findings,
          missingRequirements: criticResult.missingRequirements,
        },
      };

      if (attempt.number <= record.producerSpec.maxRepairAttempts + 1) {
        state.phase = "repair-pending";
        attempt.feedback = repairTask(record, evaluation);
        attempt.status = "failed";
        if (!record.errors) record.errors = [];
        record.errors = [...record.errors, ...evaluation.errors];
        writeRecord(ctx.cwd, record);
        return await runProducerCycle(backend, ctx, signal, record, state);
      }

      attempt.status = "failed";
      attempt.error = criticResult.summary;
      record.status = "failed";
      record.errors = evaluation.errors as string[];
      writeRecord(ctx.cwd, record);
      return { phase: "failed", evaluation, record };
    }

    // Critic approved.
    record.status = "completed";
    if (!record.review) {
      record.review = {
        verdict: "approve",
        summary: criticResult.summary,
        findings: criticResult.findings,
        missingRequirements: criticResult.missingRequirements,
      };
    }
    writeRecord(ctx.cwd, record);
    return {
      phase: "completed",
      evaluation: producerEvaluation,
      record,
    };
  } catch (error) {
    if (state.materializedCritic) {
      releaseMaterializedAgent(state.materializedCritic);
    }
    throw error;
  }
}

// ── Helper: build subagent params from contract ─────────────────────────────

export function buildSubagentParams(
  contract: ContractArtifact,
  materializedAgentName: string,
): {
  agent: string;
  model?: string;
  thinking: string;
  cwd: string;
  maxTurns: number;
  graceTurns: number;
  toolSoft: number;
  toolHard: number;
  toolBlock: readonly string[];
  maxSubagentDepth: number;
  timeoutMs: number;
  async: boolean;
  clarify: boolean;
} {
  return {
    agent: materializedAgentName,
    ...(contract.runtime.model ? { model: contract.runtime.model } : {}),
    thinking: contract.runtime.thinking,
    cwd: contract.runtime.cwd,
    maxTurns: contract.runtime.turnBudget.maxTurns,
    graceTurns: contract.runtime.turnBudget.graceTurns,
    toolSoft: contract.runtime.toolBudget.soft,
    toolHard: contract.runtime.toolBudget.hard,
    toolBlock: contract.runtime.toolBudget.block,
    maxSubagentDepth: contract.runtime.delegation.remainingDepth,
    timeoutMs: contract.runtime.timeoutMs,
    async: true,
    clarify: false,
  };
}

// ── Helper: evaluate producer result ────────────────────────────────────────

async function evaluateProducerResult(
  record: HandleRecord,
  _contract: ContractArtifact,
  _result: { success?: boolean; error?: string; state?: string },
  cwd: string,
  _signal: AbortSignal,
): Promise<Evaluation> {
  const attempt = latestAttempt(record);

  const contractResult = await evaluateContractResult(
    attempt.contractId,
    cwd,
  );

  const verification: VerificationSummary = {
    runtimeChecks: [],
    verifyRuns: [],
    reviewFindings: [],
    contract: contractResult.contract,
  };

  if (!contractResult.ok) {
    return {
      ok: false,
      errors: contractResult.errors,
      repairable: contractResult.contract === "invalid",
      verification,
    };
  }

  return {
    ok: true,
    value: contractResult.value,
    errors: [],
    repairable: false,
    verification,
  };
}

// ── Critic task builder ─────────────────────────────────────────────────────

function buildCriticTask(
  record: HandleRecord,
  evaluation: Evaluation,
): string {
  const valuePreview = evaluation.value
    ? JSON.stringify(evaluation.value).slice(0, 500)
    : "(no value)";
  return [
    `Review the completed Phenix child assignment for handle "${record.id}".`,
    "",
    `Original task: ${record.assignment.task}`,
    "",
    `Requirements:`,
    ...record.assignment.requirements.map((r, i) => `${i + 1}. ${r}`),
    "",
    `Producer result preview: ${valuePreview}`,
    "",
    "Evaluate whether the result satisfies all requirements. Report any missing or incomplete work.",
    "Call phenix_complete with your verdict (approve/reject) and structured findings.",
  ].join("\n");
}
