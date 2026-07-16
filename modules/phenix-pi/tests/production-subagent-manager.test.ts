import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentClientRef } from "../extensions/phenix-kernel/refs.ts";
import type {
  ChildRun,
  ContractSubmissionChannel,
} from "../extensions/phenix-runtime/child-session-types.ts";
import { childRunId } from "../extensions/phenix-runtime/child-session-types.ts";
import type {
  AcceptanceEngine,
  AcceptancePlan,
  RuntimeBindings,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "../extensions/phenix-runtime/execution-plan.ts";
import {
  createSessionSubagentManagerFactory,
  type SubagentSessionSpawner,
} from "../extensions/phenix-runtime/index.ts";
import type { SubagentRequest } from "../extensions/phenix-runtime/subagent-api.ts";
import { returnsWithDecoder } from "../extensions/phenix-runtime/subagent-api.ts";
import type { ContractArtifact } from "../extensions/phenix-subagents/contract.ts";
import { ExecutionQualityService } from "../extensions/phenix-subagents/execution-quality-service.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";
import { WorkflowAcceptanceEngine } from "../extensions/phenix-subagents/workflow-acceptance-engine.ts";

interface SummaryResult {
  readonly summary: string;
}

const runtime = {
  id: childRunId("managed-test"),
  rootId: childRunId("managed-test"),
  handleId: "managed-handle",
  cwd: "/tmp",
  contract: {},
  workflowProjection: { options: [] },
  contractChannel: {},
  parentContext: {},
  effectiveTools: [],
  skillRefs: [],
  extensionRefs: [],
  inheritProjectContext: true,
  timeoutMs: 1_000,
  turnBudget: {},
  toolBudget: {},
} as unknown as RuntimeBindings;

class RecordingCompiler implements SubagentExecutionCompiler {
  requests: SubagentRequest<unknown>[] = [];

  compile<TOutput>(
    request: SubagentRequest<TOutput>,
    _signal: AbortSignal,
  ): Promise<SubagentExecutionPlan<TOutput>> {
    this.requests.push(request);
    return Promise.resolve({
      assignment: {
        task: request.task,
        requirements: request.requirements ?? [],
      },
      session: {
        options: request.session,
        defaults: {
          agent: "scout",
          modelSet: "mixed" as never,
          difficulty: "D1",
          thinking: "low",
          persistence: "memory",
        },
      },
      runtime,
      acceptance: {
        kind: "test",
        returns: request.returns,
      },
    });
  }
}

class RecordingSpawner implements SubagentSessionSpawner {
  readonly plans: SubagentExecutionPlan<unknown>[] = [];

  spawn(execution: SubagentExecutionPlan<unknown>): Promise<ChildRun> {
    this.plans.push(execution);
    return Promise.resolve({
      id: execution.runtime.id,
      backend: "sdk",
      pi: { sessionId: "pi-managed-test" },
      snapshot: () => ({
        id: execution.runtime.id,
        rootId: execution.runtime.rootId,
        handleId: execution.runtime.handleId,
        role: "scout",
        agentClient: agentClientRef("scout"),
        model: { provider: "test", id: "test-model" },
        thinkingLevel: "low",
        contractId: "test-contract",
        backend: "sdk",
        pi: { sessionId: "pi-managed-test" },
        status: "running",
        startedAt: new Date().toISOString(),
      }),
      subscribe: () => () => undefined,
      continue: async () => ({ cycle: 2, status: "settled" }),
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async () => undefined,
      dispose: async () => undefined,
    });
  }
}

class ImmediateAcceptance implements AcceptanceEngine {
  evaluate<TOutput>(plan: AcceptancePlan<TOutput>): Promise<TOutput> {
    return Promise.resolve(plan.returns.decode?.({ summary: "managed" }) as TOutput);
  }
}

function producerRecord(): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    id: "workflow-managed",
    sessionId: "workflow-session",
    modelSet: "mixed",
    assignment: {
      task: "Produce a typed result.",
      requirements: [],
      outputSchema: { type: "object" },
    },
    producerSpec: {
      verificationCommands: [],
      criticRequired: false,
    } as HandleRecord["producerSpec"],
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

describe("production SubagentManager composition", () => {
  it("constructs a scoped manager that compiles, spawns, and accepts results", async () => {
    const compiler = new RecordingCompiler();
    const sessions = new RecordingSpawner();
    const factory = createSessionSubagentManagerFactory({
      sessions,
      acceptance: new ImmediateAcceptance(),
    });
    const manager = factory.create(compiler);

    const result = await manager.run({
      task: "Inspect the managed runtime.",
      returns: returnsWithDecoder<SummaryResult>(
        { type: "object" },
        (value) => value as SummaryResult,
      ),
    });

    assert.deepEqual(result, { summary: "managed" });
    assert.equal(compiler.requests.length, 1);
    assert.equal(sessions.plans.length, 1);
    assert.equal(sessions.plans[0]?.assignment.task, "Inspect the managed runtime.");
  });

  it("runs workflow producer acceptance and disposes the child session", async () => {
    let accepted = false;
    let disposed = false;
    const channel: ContractSubmissionChannel = {
      current: () => ({
        contractId: "workflow-contract",
        state: accepted ? "accepted" : "submitted",
        revision: 1,
        outputSchema: { type: "object" },
      }),
      submit: async () => ({ ok: true, state: "submitted", revision: 1 }),
      reopen: async () => undefined,
      accept: async () => {
        accepted = true;
      },
      cancel: async () => undefined,
      readSubmitted: async () => ({ value: { summary: "accepted" }, revision: 1 }),
    };
    const record = producerRecord();
    const quality = new ExecutionQualityService({
      sessions: new RecordingSpawner(),
      runVerification: async () => [],
    });
    const engine = new WorkflowAcceptanceEngine({ quality });
    const contractArtifact = {
      assignment: { outputSchema: { type: "object" } },
    } as ContractArtifact;
    const run: ChildRun = {
      id: childRunId("workflow-managed"),
      backend: "sdk",
      pi: { sessionId: "pi-workflow-managed" },
      snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
      subscribe: () => () => undefined,
      continue: async () => ({ cycle: 2, status: "settled" }),
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };

    const result = await engine.evaluate(
      {
        kind: "workflow-producer",
        returns: returnsWithDecoder<SummaryResult>(
          { type: "object" },
          (value) => value as SummaryResult,
        ),
        data: {
          record,
          contractArtifact,
          contractChannel: channel,
          cwd: "/tmp",
          maximumProducerCycles: 1,
          completionGraceRemaining: 0,
        },
      },
      run,
      new AbortController().signal,
    );

    assert.deepEqual(result, { summary: "accepted" });
    assert.equal(record.status, "completed");
    assert.equal(accepted, true);
    assert.equal(disposed, true);
  });
});
