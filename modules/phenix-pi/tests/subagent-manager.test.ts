import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Static, Type } from "typebox";

import {
  createSubagentManager,
  returns,
  routing,
  type SubagentCancellation,
  type SubagentEvent,
  type SubagentExecutionAdapter,
  SubagentExecutionError,
  type SubagentHandle,
  type SubagentRequest,
  type SubagentSnapshot,
  type SubagentStatus,
} from "../extensions/phenix-runtime/index.ts";

const SummarySchema = Type.Object({
  summary: Type.String(),
});

type SummaryResult = Static<typeof SummarySchema>;

function request(): SubagentRequest<SummaryResult> {
  return {
    task: "Inspect the session runtime.",
    returns: returns(SummarySchema),
    session: {
      agent: "scout",
      model: routing.get("scout"),
      thinking: "medium",
    },
  };
}

interface FakeHandleOptions {
  readonly id?: string;
  readonly status?: SubagentStatus;
  readonly parentId?: string;
}

class FakeHandle<TOutput> implements SubagentHandle<TOutput> {
  readonly id: string;
  readonly value: TOutput;
  readonly resultSignals: Array<AbortSignal | undefined> = [];
  readonly sent: string[] = [];
  readonly cancellations: Array<string | SubagentCancellation | undefined> = [];
  private readonly status: SubagentStatus;
  private readonly parentId: string | undefined;

  constructor(value: TOutput, options: FakeHandleOptions = {}) {
    this.value = value;
    this.id = options.id ?? "handle-test";
    this.status = options.status ?? "running";
    this.parentId = options.parentId;
  }

  snapshot(): SubagentSnapshot {
    return {
      id: this.id,
      status: this.status,
      ...(this.parentId ? { parentId: this.parentId } : {}),
    };
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

  cancel(cancellation?: string | SubagentCancellation): Promise<void> {
    this.cancellations.push(cancellation);
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

  constructor(value: SummaryResult = { summary: "done" }, options: FakeHandleOptions = {}) {
    this.handle = new FakeHandle(value, options);
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

  it("runs by spawning and awaiting the schema-derived result", async () => {
    const adapter = new RecordingAdapter({ summary: "typed result" });
    const manager = createSubagentManager(adapter);
    const controller = new AbortController();

    const result = await manager.run(request(), controller.signal);

    assert.deepEqual(result, { summary: "typed result" });
    assert.equal(adapter.handle.resultSignals[0], controller.signal);
  });

  it("registers spawned handles for typed get", async () => {
    const adapter = new RecordingAdapter({ summary: "typed" }, { id: "typed-handle" });
    const manager = createSubagentManager(adapter);

    const spawned = await manager.spawn(request());
    const stored = manager.get<SummaryResult>(spawned.id);

    assert.equal(stored, spawned);
    assert.deepEqual(await stored?.result(), { summary: "typed" });
    assert.equal(manager.get("missing"), undefined);
  });

  it("lists snapshots and filters by parent and status", async () => {
    const first = createSubagentManager(
      new RecordingAdapter({ summary: "first" }, { id: "first", parentId: "root" }),
    );
    await first.spawn(request());

    assert.deepEqual(first.list(), [{ id: "first", status: "running", parentId: "root" }]);
    assert.deepEqual(first.list({ parentId: "root" }), first.list());
    assert.deepEqual(first.list({ status: "running" }), first.list());
    assert.deepEqual(first.list({ status: ["completed", "failed"] }), []);
    assert.deepEqual(first.list({ parentId: "other" }), []);
  });

  it("does not cancel the child when an awaited result signal is cancelled", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(manager.run(request(), controller.signal), (error: unknown) => {
      return error instanceof SubagentExecutionError && error.code === "ABORTED";
    });
    assert.equal(adapter.handle.cancellations.length, 0);
  });

  it("supports structured cancellation reasons on managed handles", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);
    const handle = await manager.spawn(request());

    await handle.cancel({ code: "TIMEOUT", reason: "deadline exceeded" });

    assert.deepEqual(adapter.handle.cancellations, [
      { code: "TIMEOUT", reason: "deadline exceeded" },
    ]);
  });

  it("validates requests before invoking the adapter", async () => {
    const adapter = new RecordingAdapter();
    const manager = createSubagentManager(adapter);

    await assert.rejects(manager.spawn({ ...request(), task: "   " }), /task must be non-empty/);
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

  it("narrows public event payloads by event type", () => {
    const event: SubagentEvent = {
      type: "tool.completed",
      snapshot: { id: "handle-test", status: "running" },
      toolName: "read",
      isError: false,
    };

    if (event.type === "tool.completed") {
      assert.equal(event.toolName, "read");
      assert.equal(event.isError, false);
    }
  });
});
