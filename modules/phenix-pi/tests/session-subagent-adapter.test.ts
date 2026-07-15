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
  type CompiledSubagentExecution,
  createSessionSubagentExecutionAdapter,
  createSubagentManager,
  returns,
  routing,
  type SubagentExecutionCompiler,
  SubagentExecutionError,
  type SubagentRequest,
  type SubagentSessionSpawner,
} from "../extensions/phenix-runtime/index.ts";
import type { SubagentSessionRequest } from "../extensions/phenix-runtime/subagent-session-runtime.ts";

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

const sessionRequest = {
  task: "Inspect the adapter boundary.",
} as unknown as SubagentSessionRequest;

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRun implements ChildRun {
  readonly id = childRunId("adapter-child");
  readonly backend = "sdk" as const;
  readonly pi = { sessionId: "pi-adapter-child" };
  readonly messages: string[] = [];
  readonly listeners = new Set<(event: ChildSessionEvent) => void>();
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

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  continue(message: string, _signal?: AbortSignal): Promise<ChildCycleOutcome> {
    this.messages.push(message);
    return Promise.resolve({ cycle: this.messages.length + 1, status: "settled" });
  }

  waitForCurrentCycle(_signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return Promise.resolve({ cycle: 1, status: "settled" });
  }

  abort(reason: string): Promise<void> {
    this.abortCalls++;
    this.status = "cancelled";
    const event: ChildSessionEvent = {
      type: "session.cancelled",
      runId: this.id,
      reason,
    };
    for (const listener of this.listeners) listener(event);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    this.status = "disposed";
    return Promise.resolve();
  }
}

class RecordingSpawner implements SubagentSessionSpawner {
  readonly run = new FakeRun();
  requests: SubagentSessionRequest[] = [];
  signals: Array<AbortSignal | undefined> = [];

  spawn(requestValue: SubagentSessionRequest, signal?: AbortSignal): Promise<ChildRun> {
    this.requests.push(requestValue);
    this.signals.push(signal);
    return Promise.resolve(this.run);
  }
}

class RecordingCompiler implements SubagentExecutionCompiler {
  requests: SubagentRequest<unknown>[] = [];
  signals: AbortSignal[] = [];
  evaluator: (run: ChildRun, signal: AbortSignal) => Promise<SummaryResult>;

  constructor(
    evaluator: (run: ChildRun, signal: AbortSignal) => Promise<SummaryResult> = () =>
      Promise.resolve({ summary: "done" }),
  ) {
    this.evaluator = evaluator;
  }

  compile<TOutput>(
    requestValue: SubagentRequest<TOutput>,
    signal: AbortSignal,
  ): Promise<CompiledSubagentExecution<TOutput>> {
    this.requests.push(requestValue);
    this.signals.push(signal);
    return Promise.resolve({
      session: sessionRequest,
      evaluate: (run, evaluationSignal) =>
        this.evaluator(run, evaluationSignal) as Promise<unknown> as Promise<TOutput>,
    });
  }
}

function managerWith(compiler: RecordingCompiler, spawner = new RecordingSpawner()) {
  const adapter = createSessionSubagentExecutionAdapter({
    compiler,
    sessions: spawner,
  });
  return {
    manager: createSubagentManager(adapter),
    spawner,
  };
}

describe("SessionSubagentExecutionAdapter", () => {
  it("compiles the public request and returns its typed evaluated result", async () => {
    const compiler = new RecordingCompiler();
    const { manager, spawner } = managerWith(compiler);
    const input = request();

    const result = await manager.run(input);

    assert.deepEqual(result, { summary: "done" });
    assert.equal(compiler.requests[0], input);
    assert.equal(spawner.requests[0], sessionRequest);
  });

  it("projects the live child session through the public handle", async () => {
    const evaluation = deferred<SummaryResult>();
    const compiler = new RecordingCompiler(() => evaluation.promise);
    const { manager } = managerWith(compiler);
    const handle = await manager.spawn(request());

    assert.deepEqual(handle.snapshot(), {
      id: "adapter-child",
      status: "running",
      model: { provider: "opencode-go", id: "deepseek-v4-flash" },
      thinking: "medium",
    });
    await handle.send("Continue the inspection.");
    assert.deepEqual((await handle.poll()).model, {
      provider: "opencode-go",
      id: "deepseek-v4-flash",
    });

    evaluation.resolve({ summary: "done" });
    assert.deepEqual(await handle.result(), { summary: "done" });
  });

  it("cancels a result wait without cancelling shared child execution", async () => {
    const evaluation = deferred<SummaryResult>();
    const compiler = new RecordingCompiler(() => evaluation.promise);
    const { manager, spawner } = managerWith(compiler);
    const handle = await manager.spawn(request());
    const waitController = new AbortController();
    waitController.abort();

    await assert.rejects(handle.result(waitController.signal), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(spawner.run.abortCalls, 0);

    evaluation.resolve({ summary: "completed after detached wait" });
    assert.deepEqual(await handle.result(), {
      summary: "completed after detached wait",
    });
  });

  it("does not retain the caller startup signal after the handle is returned", async () => {
    const evaluation = deferred<SummaryResult>();
    const compiler = new RecordingCompiler(() => evaluation.promise);
    const { manager, spawner } = managerWith(compiler);
    const controller = new AbortController();
    const handle = await manager.spawn(request(), controller.signal);

    controller.abort();
    assert.equal(spawner.run.abortCalls, 0);

    evaluation.resolve({ summary: "still running" });
    assert.deepEqual(await handle.result(), { summary: "still running" });
  });

  it("explicitly cancels both evaluation and the child run", async () => {
    const compiler = new RecordingCompiler((_run, signal) => {
      return new Promise<SummaryResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new SubagentExecutionError("ABORTED", "evaluation cancelled")),
          { once: true },
        );
      });
    });
    const { manager, spawner } = managerWith(compiler);
    const handle = await manager.spawn(request());

    await handle.cancel("stop requested");

    await assert.rejects(handle.result(), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(spawner.run.abortCalls, 1);
    assert.equal(handle.snapshot().status, "cancelled");
  });
});
