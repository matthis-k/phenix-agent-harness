/**
 * workflow-acceptance-engine — interpret producer acceptance policy
 *
 * This is the production AcceptanceEngine for workflow-owned producer sessions.
 * It runs schema validation, repair cycles, deterministic verification, and
 * critic review, then returns the decoded structured result.
 */

import type { ContractSubmissionChannel } from "../phenix-runtime/child-session-types.ts";
import { type ChildRun, ChildRuntimeError } from "../phenix-runtime/child-session-types.ts";
import type { AcceptanceEngine, AcceptancePlan } from "../phenix-runtime/execution-plan.ts";
import { decodeReturnValue } from "../phenix-runtime/subagent-api.ts";
import { SubagentExecutionError } from "../phenix-runtime/subagent-manager.ts";
import { type AttemptRunResult, executeProducerCycles } from "./attempt-runner.ts";
import type { ContractArtifact } from "./contract.ts";
import type { ExecutionQualityService } from "./execution-quality-service.ts";
import type { HandleRecord } from "./handle-types.ts";

export interface WorkflowProducerAcceptanceData {
  readonly record: HandleRecord;
  readonly contractArtifact: ContractArtifact;
  readonly contractChannel: ContractSubmissionChannel;
  readonly cwd: string;
  readonly maximumProducerCycles: number;
  readonly completionGraceRemaining: number;
}

function workflowProducerData(data: unknown): WorkflowProducerAcceptanceData {
  if (!data || typeof data !== "object") {
    throw new SubagentExecutionError(
      "INVALID_ACCEPTANCE_PLAN",
      "Workflow producer acceptance data is missing.",
    );
  }

  const value = data as Partial<WorkflowProducerAcceptanceData>;
  if (
    !value.record ||
    !value.contractArtifact ||
    !value.contractChannel ||
    typeof value.cwd !== "string" ||
    typeof value.maximumProducerCycles !== "number" ||
    typeof value.completionGraceRemaining !== "number"
  ) {
    throw new SubagentExecutionError(
      "INVALID_ACCEPTANCE_PLAN",
      "Workflow producer acceptance data is incomplete.",
    );
  }
  return value as WorkflowProducerAcceptanceData;
}

export interface WorkflowAcceptanceEngineOptions {
  readonly quality: ExecutionQualityService;
}

export class WorkflowAcceptanceEngine implements AcceptanceEngine {
  private readonly quality: ExecutionQualityService;

  constructor(options: WorkflowAcceptanceEngineOptions) {
    this.quality = options.quality;
  }

  async evaluate<TOutput>(
    plan: AcceptancePlan<TOutput>,
    run: ChildRun,
    signal: AbortSignal,
  ): Promise<TOutput> {
    if (plan.kind !== "workflow-producer") {
      throw new SubagentExecutionError(
        "UNSUPPORTED_ACCEPTANCE_PLAN",
        `Unsupported acceptance plan kind: ${plan.kind}`,
      );
    }

    const data = workflowProducerData(plan.data);
    let result: AttemptRunResult;
    try {
      result = await executeProducerCycles({
        run,
        contractChannel: data.contractChannel,
        contractArtifact: data.contractArtifact,
        record: data.record,
        cwd: data.cwd,
        signal,
        maximumProducerCycles: data.maximumProducerCycles,
        completionGraceRemaining: data.completionGraceRemaining,
        verify: (input) => this.quality.verify(input),
        criticFactory: (input) => this.quality.review(input),
      });
    } finally {
      await run.dispose();
    }

    if (!result.ok) {
      const code =
        result.error?.code ??
        (result.status === "cancelled" ? "ABORTED" : "SUBAGENT_EXECUTION_FAILED");
      const message = result.error?.message ?? `Producer execution ${result.status}.`;
      throw new SubagentExecutionError(code, message, {
        cause: new ChildRuntimeError(code === "ABORTED" ? "ABORTED" : "PROVIDER_FAILED", message),
      });
    }

    return decodeReturnValue(plan.returns, result.value);
  }
}

export function createWorkflowAcceptanceEngine(
  options: WorkflowAcceptanceEngineOptions,
): WorkflowAcceptanceEngine {
  return new WorkflowAcceptanceEngine(options);
}
