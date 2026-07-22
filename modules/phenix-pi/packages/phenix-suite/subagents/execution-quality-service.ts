/**
 * execution-quality-service — deterministic verification and critic execution
 *
 * The workflow delegator sequences workflow lifecycle. This service owns the concrete
 * mechanisms used to assess producer work: verification commands and an
 * isolated critic child session. Critic execution uses the same canonical
 * SubagentExecutionPlan and session runtime as every other child.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import { validateSchema } from "@matthis-k/phenix-contracts/validator.ts";
import { computeOptionsDigest } from "@matthis-k/phenix-flow/workflow-projection.ts";
import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import type { ChildRun } from "../runtime/child-session-types.ts";
import {
  ChildRuntimeError,
  childRunId,
  isChildRuntimeErrorCode,
} from "../runtime/child-session-types.ts";
import { ContractSubmissionChannelImpl } from "../runtime/contract-channel.ts";
import type { SubagentExecutionPlan } from "../runtime/execution-plan.ts";
import { FileContractStore } from "./contract-store.ts";
import { findProjectRoot } from "./handle-store.ts";
import type { CriticValue } from "./handle-types.ts";
import { CRITIC_OUTPUT_SCHEMA } from "./handle-types.ts";
import { createProducerContract } from "./producer-contract.ts";
import type {
  CriticRunInput,
  CriticRunResult,
  VerificationInput,
  VerificationResult,
} from "./producer-cycle-runner.ts";
import { runVerificationCommands } from "./verification.ts";

export interface ExecutionQualitySessionRuntime {
  spawn(execution: SubagentExecutionPlan<unknown>, signal?: AbortSignal): Promise<ChildRun>;
}

export type VerificationCommandRunner = typeof runVerificationCommands;

export interface ExecutionQualityServiceOptions {
  readonly sessions: ExecutionQualitySessionRuntime;
  readonly runVerification?: VerificationCommandRunner;
}

export class ExecutionQualityService {
  private readonly sessions: ExecutionQualitySessionRuntime;
  private readonly runVerification: VerificationCommandRunner;

  constructor(options: ExecutionQualityServiceOptions) {
    this.sessions = options.sessions;
    this.runVerification = options.runVerification ?? runVerificationCommands;
  }

  async verify(input: VerificationInput): Promise<VerificationResult> {
    const runs = await this.runVerification(
      input.record.producerSpec.verificationCommands,
      input.cwd,
      input.signal,
    );

    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "timed-out" || run.status === "cancelled",
    );
    const summary = {
      acceptanceStatus: failed.length === 0 ? "verified" : "rejected",
      runtimeChecks: [],
      verifyRuns: runs.map(
        (run) =>
          `${run.id}: ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`,
      ),
      reviewFindings: [],
      contract: "valid" as const,
    };

    return {
      ok: failed.length === 0,
      issues: failed.map((run) => ({
        path: ["verification", run.id],
        code: run.status,
        message: [`Verification command "${run.id}" ${run.status}.`, run.stderr, run.stdout]
          .filter(Boolean)
          .join("\n"),
      })),
      summary,
    };
  }

  async review(input: CriticRunInput): Promise<CriticRunResult> {
    const criticSpec = input.record.criticSpec;
    if (!criticSpec) {
      throw new Error("Required critic specification is missing.");
    }

    const criticTask = [
      `Review the completed Phenix child assignment for handle "${input.record.id}".`,
      "",
      `Original task: ${input.record.assignment.task}`,
      "",
      "Requirements:",
      ...input.record.assignment.requirements.map(
        (requirement, index) => `${index + 1}. ${requirement}`,
      ),
      "",
      "Producer result:",
      JSON.stringify(input.producerValue, null, 2),
      "",
      "Deterministic verification evidence:",
      JSON.stringify(input.verification, null, 2),
      "",
      "Return an independent approve/reject verdict through phenix_complete.",
    ].join("\n");

    const issued = await createProducerContract({
      spec: criticSpec,
      assignment: {
        task: criticTask,
        requirements: input.record.assignment.requirements,
        outputSchema: CRITIC_OUTPUT_SCHEMA,
      },
      identity: {
        handleId: `${input.record.id}-critic-${randomUUID()}`,
        parentHandleId: input.record.id,
      },
      cwd: input.cwd,
    });

    const store = new FileContractStore(
      path.join(findProjectRoot(input.cwd), ".phenix-agent-state", "contracts"),
    );
    const channel = new ContractSubmissionChannelImpl(store, issued.artifact);

    const runId = childRunId(`critic_${input.record.id}_${randomUUID()}`);
    const parentRunId = input.record.subagentId ? childRunId(input.record.subagentId) : undefined;
    const rootRunId = input.record.rootSubagentId
      ? childRunId(input.record.rootSubagentId)
      : (parentRunId ?? runId);
    const workflowProjection = {
      difficulty: criticSpec.workflow.difficulty,
      currentState: "reviewing",
      revision: 0,
      optionsDigest: computeOptionsDigest([]),
      options: [],
    } as const;

    const executionPlan: SubagentExecutionPlan<unknown> = {
      assignment: {
        task: criticTask,
        requirements: input.record.assignment.requirements,
      },
      session: {
        options: {
          agent: "critic",
          thinking: criticSpec.thinking,
          persistence: "file",
        },
        defaults: {
          agent: "critic",
          modelSet: modelSetId(input.record.modelSet),
          difficulty: criticSpec.workflow.difficulty,
          thinking: criticSpec.thinking,
          persistence: "file",
        },
      },
      runtime: {
        id: runId,
        ...(parentRunId ? { parentId: parentRunId } : {}),
        rootId: rootRunId,
        handleId: `${input.record.id}-critic`,
        cwd: input.cwd,
        contract: issued.artifact,
        workflowProjection,
        contractChannel: channel,
        parentContext: {
          kind: "child",
          sessionId: input.record.sessionId,
          cwd: input.cwd,
          contractId: issued.artifact.id,
          contract: issued.artifact,
          handleId: `${input.record.id}-critic`,
          childRunId: runId,
          rootChildRunId: rootRunId,
          modelSet: input.record.modelSet,
          maximumDelegationDepth: 0,
          taskAuthoritySource: "runtime-internal",
        },
        effectiveTools: criticSpec.tools.effective,
        skillRefs: criticSpec.skills,
        extensionRefs: criticSpec.extensions,
        inheritProjectContext: true,
        timeoutMs: criticSpec.timeoutMs,
        turnBudget: criticSpec.turnBudget,
        toolBudget: criticSpec.toolBudget,
      },
      acceptance: {
        kind: "critic",
        returns: { schema: CRITIC_OUTPUT_SCHEMA },
        data: { parentHandleId: input.record.id },
      },
    };

    const criticController = new AbortController();
    const abortCriticFromParent = (): void => {
      if (!criticController.signal.aborted) {
        criticController.abort(
          input.signal.reason ??
            new ChildRuntimeError("ABORTED", "Critic execution was cancelled by its parent."),
        );
      }
    };

    if (input.signal.aborted) {
      abortCriticFromParent();
    } else {
      input.signal.addEventListener("abort", abortCriticFromParent, { once: true });
    }

    let criticTimeout: NodeJS.Timeout | undefined;
    if (criticSpec.timeoutMs > 0) {
      criticTimeout = setTimeout(() => {
        if (!criticController.signal.aborted) {
          criticController.abort(
            new ChildRuntimeError("TIMEOUT", `Critic timed out after ${criticSpec.timeoutMs}ms.`),
          );
        }
      }, criticSpec.timeoutMs);
      criticTimeout.unref?.();
    }

    let run: ChildRun | undefined;
    try {
      run = await this.sessions.spawn(executionPlan, criticController.signal);
      const outcome = await run.waitForCurrentCycle(criticController.signal);
      if (outcome.status !== "settled") {
        const code =
          outcome.status === "cancelled"
            ? "ABORTED"
            : isChildRuntimeErrorCode(outcome.error?.code)
              ? outcome.error.code
              : "PROVIDER_FAILED";
        throw new ChildRuntimeError(
          code,
          outcome.error?.message ?? "Critic session did not settle successfully.",
        );
      }

      const submitted = await channel.readSubmitted();
      if (!submitted) {
        throw new Error("Critic did not submit a structured verdict.");
      }

      const validation = validateSchema(CRITIC_OUTPUT_SCHEMA, submitted.value);
      if (!validation.ok) {
        throw new Error(`Critic verdict failed schema validation: ${validation.summary}`);
      }

      if (criticController.signal.aborted) {
        const reason = criticController.signal.reason;
        throw reason instanceof ChildRuntimeError
          ? reason
          : new ChildRuntimeError(
              "ABORTED",
              reason instanceof Error ? reason.message : "Critic execution was cancelled.",
            );
      }

      await channel.accept(submitted.value);
      return submitted.value as CriticValue;
    } finally {
      input.signal.removeEventListener("abort", abortCriticFromParent);
      if (criticTimeout) {
        clearTimeout(criticTimeout);
      }
      if (run) {
        await run.dispose();
      }
    }
  }
}

export function createExecutionQualityService(
  options: ExecutionQualityServiceOptions,
): ExecutionQualityService {
  return new ExecutionQualityService(options);
}
