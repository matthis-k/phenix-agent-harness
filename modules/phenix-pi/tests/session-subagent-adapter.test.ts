import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentClientRef } from "../extensions/phenix-kernel/refs.ts";
import {
  type ChildCycleOutcome,
  type ChildRun,
  type ChildSessionEvent,
  type ChildSessionNode,
  childRunId,
} from "../extensions/phenix-runtime/child-session-types.ts";
import {
  type AcceptanceEngine,
  createSessionSubagentExecutionAdapter,
  createSubagentManager,
  returns,
  routing,
  type RuntimeBindings,
  type SubagentExecutionCompiler,
  SubagentExecutionError,
  type SubagentExecutionPlan,
  type SubagentRequest,
  type SubagentSessionSpawner,
} from "../extensions/phenix-runtime/index.ts";

interface SummaryResult {
  readonly summary: string;
}

function request(): SubagentRequest<SummaryResult> {
  return {
    task: "Inspect the adapter boundary.",
    returns: returns<SummaryResult>({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    }),
    session: {
      agent: "scout",
      model: routing.get("scout"),
      thinking: "medium",
    },
  };
}

const runtime = {
  id: childRunId("adapter-child"),
  rootId: childRunId("adapter-child"),
  handleId: "adapter-handle",
  cwd: "/tmp/adapter-test",
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function plan<TOutput>(input: SubagentRequest<TOutput>): SubagentExecutionPlan<TOutput> {
  return {
    assignment: {
      task: input.task,
      requirements: input.requirements ?? [],
    },
    session: {
      options: input.session,
      defaults: {
        agent: "scout",
        modelSet: "mixed" as never,
        difficulty: "D1",
        thinking: "medium",
        persistence: "memory",
      },
    },
    runtime,
    acceptance: {
      kind: "test",
      returns: input.returns,
    },
  };
}

class FakeRun implements ChildRun {
  readonly id = runtime.id;
  readonly backend = "sdk" as const;
  readonly pi = { sessionId: "pi-adapter-child" };
  readonly messages: string[] = [];
  abortCalls = 0;

  private status: ChildSessionNode["status"] = "running";

  snapshot(): ChildSessionNode {
    return {
      id: this.id,
      rootId: this.id,
      handleId: "adapter-handle",
      role: "scout",
      agentClient: agentClientRef("scout"),
      model: { provider: "opencode-go", id: "deepseek-v4-flash" },
      thinkingLevel: "medium",
      contractId: "adapter-contract",
      backend: "sdk",
      pi: this.pi,
      status: this.status,
      startedAt: "2026-07-15T00:00:00.000Z",
    };
  }

  subscribe(_listener: (event: ChildSessionEvent) => void): () => void {
    return () => {};
  }

  continue(message: string, _signal?: AbortSignal): Promise<ChildCycleOutcome> {
    this.messages.push(message);
    return Promise.resolve({ cycle: this.messages.length + 1, status: "settled" });
  }

  waitForCurrentCycle(_signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return Promise.resolve({ cycle: 1, status: "settled" });
  }

  abort(_reason: string): Promise<void> {
    this.abortCalls++;
    this.status = "cancelled";
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.status = "disposed";
    return Promise.resolve();
  }
}

class RecordingCompiler implements SubagentExecutionCompiler {
  requests: SubagentRequest<unknown>[] = [];

  compile<TOutput>(
    input: SubagentRequest<TOutput>,
    _signal: AbortSignal,
  ): Promise<SubagentExecutionPlan<TOutput>> {
    this.requests.push(input);
    return Promise.resolve(plan(input));
  }
}

class RecordingSpawner implements SubagentSessionSpawner {
  readonly run = new FakeRun();
  plans: SubagentExecutionPlan<unknown>[] = [];

  spawn(execution: SubagentExecutionPlan<unknown>): Promise<ChildRun> {
    this.plans.push(execution);
    return Promise.resolve(this.run);
  }
}

class RecordingAcceptance implements AcceptanceEngine {
  readonly pending = deferred<SummaryResult>();
  calls = 0;

  evaluate<TOutput>(
    _plan: SubagentExecutionPlan<TOutput>["acceptance"],
    _run: ChildRun,
    _signal: AbortSignal,
  ): Promise<TOutput> {
    this.calls++;
    return this.pending.promise as Promise<TOutput>;
  }
}

function managerWith() {
  const compiler = new RecordingCompiler();
  const sessions = new RecordingSpawner();
  const acceptance = new RecordingAcceptance();
  const adapter = createSessionSubagentExecutionAdapter({
    compiler,
    acceptance,
    sessions,
  });
  return {
    manager: createSubagentManager(adapter),
    compiler,
    sessions,
    acceptance,
  };
}

describe("SessionSubagentExecutionAdapter", () => {
  it("uses one passive plan for session creation and acceptance", async () => {
    const { manager, compiler, sessions, acceptance } = managerWith();
    const input = request();
    const handle = await manager.spawn(input);

    assert.equal(compiler.requests[0], input);
    assert.equal(sessions.plans[0]?.assignment.task, input.task);
    assert.equal(acceptance.calls, 1);
    assert.equal("evaluate" in (sessions.plans[0] ?? {}), false);

    acceptance.pending.resolve({ summary: "done" });
    assert.deepEqual(await handle.result(), { summary: "done" });
  });

  it("projects the live child session through the public handle", async () => {
    const { manager, sessions, acceptance } = managerWith();
    const handle = await manager.spawn(request());

    assert.deepEqual(handle.snapshot(), {
      id: "adapter-child",
      status: "running",
      model: { provider: "opencode-go", id: "deepseek-v4-flash" },
      thinking: "medium",
    });
    await handle.send("Continue the inspection.");
    assert.deepEqual(sessions.run.messages, ["Continue the inspection."]);

    acceptance.pending.resolve({ summary: "done" });
    assert.deepEqual(await handle.result(), { summary: "done" });
  });

  it("cancels a result wait without cancelling child execution", async () => {
    const { manager, sessions, acceptance } = managerWith();
    const handle = await manager.spawn(request());
    const waitController = new AbortController();
    waitController.abort();

    await assert.rejects(handle.result(waitController.signal), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(sessions.run.abortCalls, 0);

    acceptance.pending.resolve({ summary: "completed after detached wait" });
    assert.deepEqual(await handle.result(), {
      summary: "completed after detached wait",
    });
  });

  it("maps explicit cancellation to the child run", async () => {
    const { manager, sessions, acceptance } = managerWith();
    const handle = await manager.spawn(request());

    await handle.cancel("stop requested");
    acceptance.pending.resolve({ summary: "late success" });

    await assert.rejects(handle.result(), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(sessions.run.abortCalls, 1);
    assert.equal(handle.snapshot().status, "cancelled");
  });
});
