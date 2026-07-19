/**
 * producer-cycle-runner — producer repair cycles over one child session
 *
 * A producer handle owns one ChildRun. Repair reuses that session through
 * continue(); verification and critic review are injected runtime services.
 */

import { validateSchema } from "@matthis-k/phenix-contracts/validator.ts";
import type {
  ChildCycleOutcome,
  ChildRun,
  ContractSubmissionChannel,
} from "../runtime/child-session-types.ts";
import { ChildRuntimeError, serializeError } from "../runtime/child-session-types.ts";
import type { ContractArtifact } from "./contract.ts";
import { now, writeRecord } from "./handle-store.ts";
import type {
  CriticFinding,
  HandleRecord,
  ProducerCycleRecord,
  VerificationSummary,
} from "./handle-types.ts";

export interface ProducerCycleExecutionResult {
  readonly ok: boolean;
  readonly status: "completed" | "failed" | "cancelled";
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly record: HandleRecord;
}

export interface VerificationInput {
  readonly record: HandleRecord;
  readonly value: unknown;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
    readonly code?: string;
  }[];
  readonly summary: VerificationSummary;
}

export type VerificationFn = (input: VerificationInput) => Promise<VerificationResult>;

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
  readonly findings: readonly CriticFinding[];
  readonly missingRequirements: readonly string[];
}

export type CriticFactory = (input: CriticRunInput) => Promise<CriticRunResult>;

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
    .map((issue, index) => `${index + 1}. [${issue.path.join(".")}] ${issue.message}`)
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
    .map((issue, index) => `${index + 1}. [${issue.path.join(".")}] ${issue.message}`)
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
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.description} — ${finding.evidence}`,
    )
    .join("\n");
  return [
    "## Critic feedback",
    `The critic rejected your work: ${critic.summary}`,
    "",
    findings,
    "",
    ...(critic.missingRequirements.length > 0
      ? ["Missing requirements:", ...critic.missingRequirements.map((item) => `- ${item}`), ""]
      : []),
    "Call phenix_complete again after addressing the critic findings.",
  ].join("\n");
}

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
}

/** Execute producer repair cycles over one child session. */
export async function executeProducerCycles(
  input: ExecuteProducerCyclesInput,
): Promise<ProducerCycleExecutionResult> {
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
  } = input;

  let completionGrace = completionGraceRemaining;
  let pendingOutcome: ChildCycleOutcome | undefined;

  const finishAbortedCycle = (
    cycleRecord: ProducerCycleRecord,
  ): ProducerCycleExecutionResult | undefined => {
    if (!signal.aborted) return undefined;

    const serialized = serializeError(
      signal.reason ?? new ChildRuntimeError("ABORTED", "Producer execution was cancelled."),
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
  };

  for (let cycle = 1; cycle <= maximumProducerCycles; cycle++) {
    const cycleRecord: ProducerCycleRecord = {
      number: cycle,
      startedAt: now(),
      contractRevision: contractChannel.current().revision,
      status: "running",
    };
    record.producerCycles.push(cycleRecord);

    let outcome: ChildCycleOutcome;
    try {
      if (pendingOutcome) {
        outcome = pendingOutcome;
        pendingOutcome = undefined;
      } else {
        outcome = await run.waitForCurrentCycle(signal);
      }
    } catch (error) {
      const aborted = finishAbortedCycle(cycleRecord);
      if (aborted) return aborted;

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

    const submitted = await contractChannel.readSubmitted();
    if (!submitted) {
      if (completionGrace > 0) {
        completionGrace--;
        cycleRecord.endedAt = now();
        cycleRecord.status = "rejected";
        cycleRecord.feedback = "missing-completion";
        writeRecord(cwd, record);

        if (cycle >= maximumProducerCycles) break;

        try {
          pendingOutcome = await run.continue(buildMissingCompletionFeedback(record), signal);
        } catch (error) {
          const aborted = finishAbortedCycle(cycleRecord);
          if (aborted) return aborted;

          record.status = "failed";
          record.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(cwd, record);
          return { ok: false, status: "failed", error: serializeError(error), record };
        }
        continue;
      }

      cycleRecord.endedAt = now();
      cycleRecord.status = "failed";
      cycleRecord.error = {
        code: "CONTRACT_NOT_SUBMITTED",
        message: "Child did not submit output.",
      };
      record.status = "failed";
      record.errors = ["CONTRACT_NOT_SUBMITTED: Child did not call phenix_complete."];
      writeRecord(cwd, record);
      return {
        ok: false,
        status: "failed",
        error: cycleRecord.error,
        record,
      };
    }

    const validation = validateSchema(contractArtifact.assignment.outputSchema, submitted.value);
    if (!validation.ok) {
      const issues = validation.violations.map((violation) => ({
        path: violation.path.split("."),
        message: violation.message,
      }));
      await contractChannel.reopen({ reason: "runtime-validation", issues });
      cycleRecord.endedAt = now();
      cycleRecord.status = "rejected";
      cycleRecord.contractRevision = contractChannel.current().revision;
      cycleRecord.feedback = "validation-repair";
      writeRecord(cwd, record);

      if (cycle >= maximumProducerCycles) break;

      try {
        pendingOutcome = await run.continue(buildValidationRepairFeedback(issues), signal);
      } catch (error) {
        const aborted = finishAbortedCycle(cycleRecord);
        if (aborted) return aborted;

        record.status = "failed";
        record.errors = [error instanceof Error ? error.message : String(error)];
        writeRecord(cwd, record);
        return { ok: false, status: "failed", error: serializeError(error), record };
      }
      continue;
    }

    let verification: VerificationResult | undefined;
    if (verify) {
      verification = await verify({ record, value: submitted.value, cwd, signal });
      const aborted = finishAbortedCycle(cycleRecord);
      if (aborted) return aborted;

      if (!verification.ok) {
        await contractChannel.reopen({ reason: "verification", issues: verification.issues });
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
          const abortedAfterFeedback = finishAbortedCycle(cycleRecord);
          if (abortedAfterFeedback) return abortedAfterFeedback;

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
        criticResult = await criticFactory({
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
        const aborted = finishAbortedCycle(cycleRecord);
        if (aborted) return aborted;

        cycleRecord.endedAt = now();
        cycleRecord.status = "failed";
        cycleRecord.error = serializeError(error);
        record.status = "failed";
        record.errors = [error instanceof Error ? error.message : String(error)];
        writeRecord(cwd, record);
        return { ok: false, status: "failed", error: serializeError(error), record };
      }

      const aborted = finishAbortedCycle(cycleRecord);
      if (aborted) return aborted;

      cycleRecord.critic = {
        verdict: criticResult.verdict,
        summary: criticResult.summary,
        findings: criticResult.findings,
        missingRequirements: criticResult.missingRequirements,
      };

      if (criticResult.verdict === "reject") {
        await contractChannel.reopen({
          reason: "critic",
          issues: criticResult.findings.map((finding) => ({
            path: [finding.severity],
            message: finding.description,
          })),
        });
        cycleRecord.endedAt = now();
        cycleRecord.status = "rejected";
        cycleRecord.feedback = "critic-repair";
        writeRecord(cwd, record);

        if (cycle >= maximumProducerCycles) break;

        try {
          pendingOutcome = await run.continue(buildCriticRepairFeedback(criticResult), signal);
        } catch (error) {
          const abortedAfterFeedback = finishAbortedCycle(cycleRecord);
          if (abortedAfterFeedback) return abortedAfterFeedback;

          record.status = "failed";
          record.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(cwd, record);
          return { ok: false, status: "failed", error: serializeError(error), record };
        }
        continue;
      }
    }

    const aborted = finishAbortedCycle(cycleRecord);
    if (aborted) return aborted;

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
        findings: cycleRecord.critic.findings,
        missingRequirements: cycleRecord.critic.missingRequirements,
      };
    }

    writeRecord(cwd, record);
    return { ok: true, status: "completed", value: submitted.value, record };
  }

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
