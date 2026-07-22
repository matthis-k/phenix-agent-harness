/**
 * workflow-acceptance-engine — interpret producer acceptance policy
 *
 * This is the production AcceptanceEngine for workflow-owned producer sessions.
 * It runs schema validation, required workflow completion checks, repair cycles,
 * deterministic verification, and critic review, then returns the decoded result.
 */

import {
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
} from "@matthis-k/phenix-flow/index.ts";
import type { ContractSubmissionChannel } from "../runtime/child-session-types.ts";
import { type ChildRun, ChildRuntimeError } from "../runtime/child-session-types.ts";
import type { AcceptanceEngine, AcceptancePlan } from "../runtime/execution-plan.ts";
import { decodeReturnValue } from "../runtime/subagent-api.ts";
import { SubagentExecutionError } from "../runtime/subagent-manager.ts";
import type { ContractArtifact } from "./contract.ts";
import type { ExecutionQualityService } from "./execution-quality-service.ts";
import { listRecords } from "./handle-store.ts";
import type { HandleRecord } from "./handle-types.ts";
import {
  executeProducerCycles,
  type ProducerCycleExecutionResult,
} from "./producer-cycle-runner.ts";
import { requiredWorkflowCompletionGate } from "./workflow-completion-gate.ts";

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
    let result: ProducerCycleExecutionResult;
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
        verify: async (input) => {
          const dependencies = buildWorkflowRuntimeDependencies({
            cwd: data.cwd,
            sessionId: data.record.sessionId,
            source: { kind: "child", contract: data.contractArtifact },
            handleStore: { listRecords },
          });
          const projection = buildWorkflowDecisionContext({
            definition: dependencies.definition,
            runtime: dependencies.record,
            authority: dependencies.authority,
            activeHandles: dependencies.activeHandles,
          });
          const workflowGate = requiredWorkflowCompletionGate(projection);
          return workflowGate ?? this.quality.verify(input);
        },
        criticFactory: (input) => this.quality.review(input),
      });
    } finally {
      await run.dispose();
    }

    if (!result.ok) {
      const code =
        result.error?.code ??
        (result.status === "cancelled" ? "ABORTED" : "SUBAGENT_EXECUTION_FAILED");
      const baseMessage = result.error?.message ?? `Producer execution ${result.status}.`;
      const message =
        data.record.candidateValue !== undefined
          ? `${baseMessage} Producer output is preserved on handle ${data.record.id} as candidateValue; semantic assurance did not complete.`
          : baseMessage;
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
