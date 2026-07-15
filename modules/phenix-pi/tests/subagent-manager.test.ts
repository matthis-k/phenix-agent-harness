import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSubagentManager,
  returns,
  routing,
  type SubagentEvent,
  type SubagentExecutionAdapter,
  SubagentExecutionError,
  type SubagentHandle,
  type SubagentRequest,
  type SubagentSnapshot,
} from "../extensions/phenix-runtime/index.ts";

interface SummaryResult {
  readonly summary: string;
}

function request(): SubagentRequest<SummaryResult> {
  return {
    task: "Inspect the session runtime.",
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

class FakeHandle<TOutput> implements SubagentHandle<TOutput> {
  readonly id = "handle-test";
  readonly value: TOutput;
  readonly resultSignals: Array<AbortSignal | undefined> = [];
  readonly sent: string[] = [];
  cancelCalls = 0;

  constructor(value: TOutput) {
    this.value = value;
  }

  snapshot(): SubagentSnapshot {
    return { id: this.id, status: "running" };
  }

  poll(): Promise<SubagentSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  result(signal?: AbortSignal): Promise<TOutput> {
    this.resultSignals.push(signal);
    if (signal?.aborted) {
      return Promise.reject(new SubagentExecutionError("ABORTED", "Result wait was cancelled."));
    }
    return Promise.resolve(this.value);
  }

  send(message: string, _signal?: AbortSignal): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  cancel(_reason?: string): Promise<void> {
    this.cancelCalls++;
    return Promise.resolve();
  }

  subscribe(_listener: (event: SubagentEvent) => void): () => void {
    return () => {};
  }
}

class RecordingAdapter implements SubagentExecutionAdapter {
  readonly handle: FakeHandle<SummaryResult>;
  requests: SubagentRequest<unknown>[] = [];
  signals: Array<AbortSignal | undefined> = [];

  constructor(value: SummaryResult = { summary: "done" }) {
    this.handle = new FakeHandle(value);
  }

  spawn<TOutput>(
    requestValue: SubagentRequest<TOutput>,
    signal?: AbortSignal,
  ): Promise<SubagentHandle<TOutput>> {
    this.requests.push(requestValue);
    this.signals.push(signal);
    return Promise.resolve(this.handle as unknown as SubagentHandle<TOutput>);
  }
}

describe("SubagentManager", () => {
  it("spawns through the execution-adapter port", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);
    const controller = new AbortController();
    const input = request();

    const handle = await manager.spawn(input, controller.signal);

    assert.equal(handle, adapter.handle);
    assert.equal(adapter.requests[0], input);
    assert.equal(adapter.signals[0], controller.signal);
  });

  it("runs by spawning and awaiting the typed handle result", async () => {
    const adapter = new RecordingAdapter({ summary: "typed result" });
    const manager = createSubagentManager(adapter);
    const controller = new AbortController();

    const result = await manager.run(request(), controller.signal);

    assert.deepEqual(result, { summary: "typed result" });
    assert.equal(adapter.handle.resultSignals[0], controller.signal);
  });

  it("does not cancel the child when an awaited result signal is cancelled", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(manager.run(request(), controller.signal), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(adapter.handle.cancelCalls, 0);
  });

  it("validates requests before invoking the adapter", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);

    await assert.rejects(
      manager.spawn({ ...request(), task: "   " }),
      /task must be non-empty/,
    );
    await assert.rejects(
      manager.spawn({
        ...request(),
        returns: { schema: [] as unknown as Record<string, unknown> },
      }),
      /return schema must be a JSON Schema object/,
    );
    await assert.rejects(
      manager.spawn({ ...request(), requirements: ["valid", ""] }),
      /requirements must be non-empty strings/,
    );
    assert.equal(adapter.requests.length, 0);
  });

  it("preserves typed execution error metadata", () => {
    const snapshot: SubagentSnapshot = {
      id: "failed-handle",
      status: "failed",
      error: { code: "PROVIDER_FAILED", message: "provider unavailable" },
    };
    const cause = new Error("transport closed");
    const error = new SubagentExecutionError("PROVIDER_FAILED", "Child failed.", {
      cause,
      snapshot,
    });

    assert.equal(error.name, "SubagentExecutionError");
    assert.equal(error.code, "PROVIDER_FAILED");
    assert.equal(error.cause, cause);
    assert.equal(error.snapshot, snapshot);
  });
});
