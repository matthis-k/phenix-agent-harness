import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ChildRun, childRunId } from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import type {
  AcceptanceEngine,
  AcceptancePlan,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "@matthis-k/phenix-suite/runtime/execution-plan.ts";
import type { SubagentRequest } from "@matthis-k/phenix-suite/runtime/subagent-api.ts";
import { createSessionSubagentManagerFactory } from "@matthis-k/phenix-suite/runtime/subagent-manager-factory.ts";

class Compiler implements SubagentExecutionCompiler {
  private readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  compile<TOutput>(
    request: SubagentRequest<TOutput>,
    _signal: AbortSignal,
  ): Promise<SubagentExecutionPlan<TOutput>> {
    const id = childRunId(this.id);
    return Promise.resolve({
      assignment: { task: request.task, requirements: request.requirements ?? [] },
      session: {
        defaults: {
          agent: "scout",
          modelSet: "mixed" as never,
          difficulty: "D1",
          thinking: "low",
          persistence: "memory",
        },
      },
      runtime: {
        id,
        rootId: id,
        handleId: this.id,
        cwd: "/tmp",
        contract: {} as never,
        workflowProjection: {} as never,
        contractChannel: {} as never,
        parentContext: {} as never,
        effectiveTools: [],
        skillRefs: [],
        extensionRefs: [],
        inheritProjectContext: true,
        timeoutMs: 1_000,
        turnBudget: {},
        toolBudget: {},
      },
      acceptance: { kind: "test", returns: request.returns },
    });
  }
}

class Spawner {
  readonly aborted: string[] = [];

  spawn(execution: SubagentExecutionPlan<unknown>): Promise<ChildRun> {
    const id = execution.runtime.id;
    return Promise.resolve({
      id,
      backend: "sdk",
      pi: { sessionId: `pi-${id}` },
      snapshot: () => ({
        id,
        rootId: execution.runtime.rootId,
        handleId: execution.runtime.handleId,
        role: "scout",
        agentClient: { id: "scout", kind: "agent" } as never,
        model: { provider: "test", id: "test" },
        thinkingLevel: "low",
        contractId: "test-contract",
        backend: "sdk",
        pi: { sessionId: `pi-${id}` },
        status: "running",
        startedAt: new Date().toISOString(),
      }),
      subscribe: () => () => undefined,
      continue: async () => ({ cycle: 2, status: "settled" }),
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async (reason) => {
        this.aborted.push(reason);
      },
      dispose: async () => undefined,
    });
  }
}

class PendingAcceptance implements AcceptanceEngine {
  evaluate<TOutput>(
    _plan: AcceptancePlan<TOutput>,
    _run: ChildRun,
    signal: AbortSignal,
  ): Promise<TOutput> {
    return new Promise<TOutput>((_resolve, reject) => {
      const abort = (): void => reject(new Error("acceptance cancelled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
}

const request: SubagentRequest<{ readonly ok: boolean }> = {
  task: "Run a managed child.",
  returns: { schema: { type: "object" } },
};

describe("SessionSubagentManagerFactory directory", () => {
  it("shares handles across compiler-scoped managers", async () => {
    const factory = createSessionSubagentManagerFactory({
      sessions: new Spawner(),
      acceptance: new PendingAcceptance(),
    });
    const first = factory.create(new Compiler("first"));
    const second = factory.create(new Compiler("second"));

    const handle = await first.spawn(request);

    assert.equal(first.get(handle.id), handle);
    assert.equal(second.get(handle.id), handle);
    assert.equal(factory.get(handle.id), handle);
    assert.deepEqual(second.list(), [handle.snapshot()]);
    assert.equal(factory.activeCount, 1);

    await factory.shutdown("test complete");
  });

  it("publishes active count changes for add, remove, and shutdown", async () => {
    const factory = createSessionSubagentManagerFactory({
      sessions: new Spawner(),
      acceptance: new PendingAcceptance(),
    });
    const activeCounts: number[] = [];
    const unsubscribe = factory.subscribeActiveCount((activeCount) => {
      activeCounts.push(activeCount);
    });

    const first = await factory.create(new Compiler("first")).spawn(request);
    await factory.create(new Compiler("second")).spawn(request);
    factory.remove(first.id);
    await factory.shutdown("session shutdown");
    unsubscribe();

    assert.deepEqual(activeCounts, [0, 1, 2, 1, 0]);
  });

  it("removes handles centrally and shuts down remaining children", async () => {
    const spawner = new Spawner();
    const factory = createSessionSubagentManagerFactory({
      sessions: spawner,
      acceptance: new PendingAcceptance(),
    });
    const first = await factory.create(new Compiler("first")).spawn(request);
    const second = await factory.create(new Compiler("second")).spawn(request);

    factory.remove(first.id);
    assert.equal(factory.get(first.id), undefined);
    assert.equal(factory.activeCount, 1);

    await factory.shutdown("session shutdown");

    assert.equal(factory.activeCount, 0);
    assert.equal(factory.get(second.id), undefined);
    assert.deepEqual(spawner.aborted, ["session shutdown"]);
  });
});
