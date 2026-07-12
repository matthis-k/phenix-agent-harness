/**
 * attempt-runner — producer repair cycles over one Pi session
 *
 * Replaces the old recursive attempt runner that created a new child session
 * for each repair. A producer handle now owns one producer ChildRun.
 *
 * Repair reuses the same Pi session via continue(). A critic is a separate
 * Pi child session.
 */

import type {
  HandleRecord,
  VerificationSummary,
  ProducerCycleRecord,
} from "./handle-types.ts";
import {
  now,
  writeRecord,
} from "./handle-store.ts";
import type { ContractArtifact } from "./contract.ts";
import type {
  ChildCycleOutcome,
  ChildRun,
  ChildSessionSpec,
  ChildSessionBackend,
  ContractSubmissionChannel,
} from "../phenix-runtime/child-session-types.ts";
import {
  childRunId,
  ChildRuntimeError,
  serializeError,
} from "../phenix-runtime/child-session-types.ts";
import { validateContract } from "./contracts.ts";

// ── Attempt run result ──────────────────────────────────────────────────────

export interface AttemptRunResult {
  readonly ok: boolean;
  readonly status: "completed" | "failed" | "cancelled";
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly record: HandleRecord;
}

// ── Verification function type ──────────────────────────────────────────────

export interface VerificationInput {
  readonly record: HandleRecord;
  readonly value: unknown;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly issues: readonly { readonly path: readonly (string | number)[]; readonly message: string; readonly code?: string }[];
  readonly summary: VerificationSummary;
}

export type VerificationFn = (
  input: VerificationInput,
) => Promise<VerificationResult>;

// ── Critic factory type ─────────────────────────────────────────────────────

export interface CriticRunInput {
  readonly record: HandleRecord;
  readonly producerValue: unknown;
  readonly verification: VerificationSummary;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface CriticRunResult {
  readonly verdict: "approve" | "reject";
  readonly summary: string;
  readonly findings: readonly { readonly severity: string; readonly description: string; readonly evidence: string; readonly requirement?: string }[];
  readonly missingRequirements: readonly string[];
}

export type CriticFactory = (
  backend: ChildSessionBackend,
  input: CriticRunInput,
) => Promise<CriticRunResult>;

// ── Repair feedback builders ────────────────────────────────────────────────

function buildMissingCompletionFeedback(record: HandleRecord): string {
  return [
    "You did not call phenix_complete before the session settled.",
    "Call phenix_complete with a value matching the required output schema.",
    "",
    `Original task: ${record.assignment.task}`,
  ].join("\n");
}

function buildValidationRepairFeedback(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
): string {
  const numbered = issues
    .map((issue, i) => `${i + 1}. [${issue.path.join(".")}] ${issue.message}`)
    .join("\n");
  return [
    "## Runtime validation feedback",
    "Your submission did not match the required output schema. Correct the following issues:",
    "",
    numbered,
    "",
    "Call phenix_complete again with a corrected value.",
  ].join("\n");
}

function buildVerificationRepairFeedback(
  issues: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
): string {
  const numbered = issues
    .map((issue, i) => `${i + 1}. [${issue.path.join(".")}] ${issue.message}`)
    .join("\n");
  return [
    "## Verification feedback",
    "The runtime verification gate rejected your work. Correct the following issues:",
    "",
    numbered,
    "",
    "Do not merely claim that checks passed. The runtime will rerun verification.",
    "Call phenix_complete again after correcting the work.",
  ].join("\n");
}

function buildCriticRepairFeedback(critic: CriticRunResult): string {
  const findings = critic.findings
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.description} — ${f.evidence}`)
    .join("\n");
  return [
    "## Critic feedback",
    `The critic rejected your work: ${critic.summary}`,
    "",
    findings,
    "",
    ...(critic.missingRequirements.length > 0
      ? ["Missing requirements:", ...critic.missingRequirements.map((r) => `- ${r}`), ""]
      : []),
    "Call phenix_complete again after addressing the critic findings.",
  ].join("\n");
}

// ── Execute producer cycles ─────────────────────────────────────────────────

export interface ExecuteProducerCyclesInput {
  readonly run: ChildRun;
  readonly contractChannel: ContractSubmissionChannel;
  readonly contractArtifact: ContractArtifact;
  readonly record: HandleRecord;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly maximumProducerCycles: number;
  readonly completionGraceRemaining: number;
  readonly verify?: VerificationFn;
  readonly criticFactory?: CriticFactory;
  readonly backend: ChildSessionBackend;
}

/**
 * Execute producer repair cycles over one Pi session.
 *
 * A producer handle owns one producer ChildRun. Repair reuses the same
 * session via continue(). A critic is a separate Pi child session.
 */
export async function executeProducerCycles(
  input: ExecuteProducerCyclesInput,
): Promise<AttemptRunResult> {
  const {
    run,
    contractChannel,
    contractArtifact,
    record,
    cwd,
    signal,
    maximumProducerCycles,
    completionGraceRemaining,
    verify,
    criticFactory,
    backend,
  } = input;

  let completionGrace = completionGraceRemaining;
  let pendingOutcome: ChildCycleOutcome | undefined;

  for (let cycle = 1; cycle <= maximumProducerCycles; cycle++) {
    const cycleRecord: ProducerCycleRecord = {
      number: cycle,
      startedAt: now(),
      contractRevision: contractChannel.current().revision,
      status: "running",
    };
    record.producerCycles.push(cycleRecord);

    // The first outcome belongs to the initial prompt. Every later outcome
    // is produced by the exact repair feedback sent in the previous branch.
    // Never manufacture an additional empty prompt between repair cycles.
    let outcome: ChildCycleOutcome;
    try {
      if (pendingOutcome) {
        outcome = pendingOutcome;
        pendingOutcome = undefined;
      } else {
        outcome = await run.waitForCurrentCycle(signal);
      }
    } catch (error) {
      cycleRecord.endedAt = now();
      cycleRecord.status = "failed";
      cycleRecord.error = serializeError(error);
      record.status = "failed";
      record.errors = [error instanceof Error ? error.message : String(error)];
      writeRecord(cwd, record);
      return {
        ok: false,
        status: "failed",
        error: serializeError(error),
        record,
      };
    }

    if (outcome.status === "cancelled") {
      cycleRecord.endedAt = now();
      cycleRecord.status = "cancelled";
      record.status = "cancelled";
      writeRecord(cwd, record);
      return { ok: false, status: "cancelled", record };
    }

    if (outcome.status === "failed") {
      cycleRecord.endedAt = now();
      cycleRecord.status = "failed";
      cycleRecord.error = outcome.error;
      record.status = "failed";
      record.errors = [outcome.error?.message ?? "producer cycle failed"];
      writeRecord(cwd, record);
      return { ok: false, status: "failed", error: outcome.error, record };
    }

    // Check if the child submitted output.
    const submitted = await contractChannel.readSubmitted();

    if (!submitted) {
      // No submission — check if we have grace remaining.
      if (completionGrace > 0) {
        completionGrace--;
        cycleRecord.endedAt = now();
        cycleRecord.status = "rejected";
        cycleRecord.feedback = "missing-completion";
        writeRecord(cwd, record);

        if (cycle >= maximumProducerCycles) break;

        try {
          pendingOutcome = await run.continue(
            buildMissingCompletionFeedback(record),
            signal,
          );
        } catch (error) {
          record.status = "failed";
          record.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(cwd, record);
          return { ok: false, status: "failed", error: serializeError(error), record };
        }
        continue;
      }

      // No grace remaining — fail with CONTRACT_NOT_SUBMITTED.
      cycleRecord.endedAt = now();
      cycleRecord.status = "failed";
      cycleRecord.error = { code: "CONTRACT_NOT_SUBMITTED", message: "Child did not submit output." };
      record.status = "failed";
      record.errors = ["CONTRACT_NOT_SUBMITTED: Child did not call phenix_complete."];
      writeRecord(cwd, record);
      return {
        ok: false,
        status: "failed",
        error: { code: "CONTRACT_NOT_SUBMITTED", message: "Child did not submit output." },
        record,
      };
    }

    // Validate the submitted output against the schema.
    const validation = validateContract(
      contractArtifact.assignment.outputSchema,
      submitted.value,
    );

    if (!validation.ok) {
      const issues = validation.violations.map((v) => ({
        path: v.path.split("."),
        message: v.message,
      }));

      await contractChannel.reopen({
        reason: "runtime-validation",
        issues,
      });

      cycleRecord.endedAt = now();
      cycleRecord.status = "rejected";
      cycleRecord.contractRevision = contractChannel.current().revision;
      cycleRecord.feedback = "validation-repair";
      writeRecord(cwd, record);

      if (cycle >= maximumProducerCycles) break;

      try {
        pendingOutcome = await run.continue(
          buildValidationRepairFeedback(issues),
          signal,
        );
      } catch (error) {
        record.status = "failed";
        record.errors = [error instanceof Error ? error.message : String(error)];
        writeRecord(cwd, record);
        return { ok: false, status: "failed", error: serializeError(error), record };
      }
      continue;
    }

    // Run deterministic verification.
    let verification: VerificationResult | undefined;
    if (verify) {
      verification = await verify({
        record,
        value: submitted.value,
        cwd,
        signal,
      });

      if (!verification.ok) {
        await contractChannel.reopen({
          reason: "verification",
          issues: verification.issues,
        });

        cycleRecord.endedAt = now();
        cycleRecord.status = "rejected";
        cycleRecord.verification = verification.summary;
        cycleRecord.feedback = "verification-repair";
        writeRecord(cwd, record);

        if (cycle >= maximumProducerCycles) break;

        try {
          pendingOutcome = await run.continue(
            buildVerificationRepairFeedback(verification.issues),
            signal,
          );
        } catch (error) {
          record.status = "failed";
          record.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(cwd, record);
          return { ok: false, status: "failed", error: serializeError(error), record };
        }
        continue;
      }

      cycleRecord.verification = verification.summary;
      record.verification = verification.summary;
    }

    // Run critic if required. Production may never silently skip a required
    // independent review.
    if (record.producerSpec.criticRequired && !criticFactory) {
      cycleRecord.endedAt = now();
      cycleRecord.status = "failed";
      cycleRecord.error = {
        code: "CRITIC_REJECTED",
        message: "Required critic runner is not configured.",
      };
      record.status = "failed";
      record.errors = ["Required critic runner is not configured."];
      writeRecord(cwd, record);
      return {
        ok: false,
        status: "failed",
        error: cycleRecord.error,
        record,
      };
    }

    if (record.producerSpec.criticRequired && criticFactory) {
      let criticResult: CriticRunResult;
      try {
        criticResult = await criticFactory(backend, {
          record,
          producerValue: submitted.value,
          verification: verification?.summary ?? {
            acceptanceStatus: "verified",
            runtimeChecks: [],
            verifyRuns: [],
            reviewFindings: [],
            contract: "valid",
          },
          cwd,
          signal,
        });
      } catch (error) {
        cycleRecord.endedAt = now();
        cycleRecord.status = "failed";
        cycleRecord.error = serializeError(error);
        record.status = "failed";
        record.errors = [error instanceof Error ? error.message : String(error)];
        writeRecord(cwd, record);
        return { ok: false, status: "failed", error: serializeError(error), record };
      }

      cycleRecord.critic = {
        verdict: criticResult.verdict,
        summary: criticResult.summary,
        findings: criticResult.findings as any,
        missingRequirements: criticResult.missingRequirements,
      };

      if (criticResult.verdict === "reject") {
        await contractChannel.reopen({
          reason: "critic",
          issues: criticResult.findings.map((f) => ({
            path: [f.severity],
            message: f.description,
          })),
        });

        cycleRecord.endedAt = now();
        cycleRecord.status = "rejected";
        cycleRecord.feedback = "critic-repair";
        writeRecord(cwd, record);

        if (cycle >= maximumProducerCycles) break;

        try {
          pendingOutcome = await run.continue(
            buildCriticRepairFeedback(criticResult),
            signal,
          );
        } catch (error) {
          record.status = "failed";
          record.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(cwd, record);
          return { ok: false, status: "failed", error: serializeError(error), record };
        }
        continue;
      }
    }

    // A total execution timeout/cancellation may have fired while
    // deterministic verification or the critic was running. Never accept
    // output after the shared execution scope has been aborted.
    if (signal.aborted) {
      const serialized = serializeError(
        signal.reason ??
          new ChildRuntimeError(
            "ABORTED",
            "Producer execution was cancelled.",
          ),
      );
      const cancelled = serialized.code === "ABORTED";
      cycleRecord.endedAt = now();
      cycleRecord.status = cancelled ? "cancelled" : "failed";
      cycleRecord.error = serialized;
      record.status = cancelled ? "cancelled" : "failed";
      record.errors = [`${serialized.code}: ${serialized.message}`];
      writeRecord(cwd, record);
      return {
        ok: false,
        status: cancelled ? "cancelled" : "failed",
        error: serialized,
        record,
      };
    }

    // All gates passed — accept the submission.
    await contractChannel.accept(submitted.value);

    cycleRecord.endedAt = now();
    cycleRecord.status = "accepted";
    cycleRecord.contractRevision = contractChannel.current().revision;
    record.value = submitted.value;
    record.status = "completed";

    if (cycleRecord.critic) {
      record.review = {
        verdict: cycleRecord.critic.verdict,
        summary: cycleRecord.critic.summary,
        findings: cycleRecord.critic.findings as any,
        missingRequirements: cycleRecord.critic.missingRequirements,
      };
    }

    writeRecord(cwd, record);
    return { ok: true, status: "completed", value: submitted.value, record };
  }

  // Exceeded repair limit.
  record.status = "failed";
  record.errors = ["Exceeded maximum producer repair cycles."];
  writeRecord(cwd, record);
  return {
    ok: false,
    status: "failed",
    error: {
      code: "REPAIR_LIMIT_EXCEEDED",
      message: "Exceeded maximum producer repair cycles.",
    },
    record,
  };
}

// ── Build child session spec from handle ────────────────────────────────────

export interface PrepareChildSessionSpecInput {
  readonly record: HandleRecord;
  readonly contractArtifact: ContractArtifact;
  readonly cwd: string;
  readonly parentId?: string;
  readonly rootId?: string;
}

/**
 * Prepare a ChildSessionSpec from a handle record and contract artifact.
 *
 * The model must already be resolved to a concrete provider/model pair
 * by routing before this point.
 */
export function prepareChildSessionSpec(
  input: PrepareChildSessionSpecInput,
  model: { readonly provider: string; readonly id: string },
): Omit<
  ChildSessionSpec,
  "workflowProjection" | "contractChannel" | "parentContext"
> {
  const { record, contractArtifact, cwd } = input;
  const spec = record.producerSpec;
  const id = childRunId(`child_${record.id}`);
  const rootId = childRunId(input.rootId ?? input.parentId ?? record.id);

  return {
    id,
    ...(input.parentId ? { parentId: childRunId(input.parentId) } : {}),
    rootId,
    handleId: record.id,
    agentClient: {
      id: spec.agent.replace("phenix.", "") as any,
      kind: "agent" as any,
    },
    role: spec.role,
    cwd,
    model,
    thinkingLevel: spec.thinking,
    initialPrompt: contractArtifact.assignment.task,
    contract: contractArtifact,
    effectiveTools: spec.tools.effective,
    skillRefs: spec.skills,
    extensionRefs: spec.extensions,
    inheritProjectContext: true,
    timeoutMs: spec.timeoutMs,
    turnBudget: spec.turnBudget,
    toolBudget: spec.toolBudget,
    persistence: "file",
  };
}
