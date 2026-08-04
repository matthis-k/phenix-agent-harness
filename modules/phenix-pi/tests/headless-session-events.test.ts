import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import {
  PiSessionEventBridge,
  type HeadlessSessionEvent,
  type SessionEventSource,
} from "../headless/session-events.ts";

test("streaming message events retain one stable transcript block identity", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "partial" }],
  };
  const bridge = createBridge();

  const started = bridge.translate({ type: "message_start", message } as AgentSessionEvent);
  message.content[0] = { type: "text", text: "complete" };
  const updated = bridge.translate({ type: "message_update", message } as AgentSessionEvent);
  const ended = bridge.translate({ type: "message_end", message } as AgentSessionEvent);

  assert.equal(started?.type, "transcript.appended");
  assert.equal(updated?.type, "transcript.updated");
  assert.equal(ended?.type, "transcript.updated");
  if (
    started?.type !== "transcript.appended" ||
    updated?.type !== "transcript.updated" ||
    ended?.type !== "transcript.updated"
  ) {
    assert.fail("expected transcript events");
  }
  assert.equal(started.block.id, updated.block.id);
  assert.equal(updated.block.id, ended.block.id);
  assert.equal(ended.block.text, "complete");
  assert.equal(ended.block.complete, true);
});

test("tool and queue events preserve run identity", () => {
  const bridge = createBridge("child-run");
  const tool = bridge.translate({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "README.md" },
  } as AgentSessionEvent);
  const queue = bridge.translate({
    type: "queue_update",
    steering: ["stop"],
    followUp: ["verify"],
  } as AgentSessionEvent);

  assert.deepEqual(tool, {
    type: "tool.started",
    runId: "child-run",
    toolCallId: "tool-1",
    toolName: "read",
    inputSummary: '{"path":"README.md"}',
  });
  assert.deepEqual(queue, {
    type: "queue.changed",
    runId: "child-run",
    steering: ["stop"],
    followUps: ["verify"],
  });
});

test("rebinding unsubscribes the previous Pi session source", () => {
  const published: HeadlessSessionEvent[] = [];
  const first = new FakeSource();
  const second = new FakeSource();
  const bridge = new PiSessionEventBridge({
    runId: () => "root-run",
    publish: (event) => published.push(event),
  });

  bridge.bind(first);
  bridge.bind(second);
  first.emit({ type: "agent_start" } as AgentSessionEvent);
  second.emit({ type: "agent_start" } as AgentSessionEvent);

  assert.equal(first.unsubscribeCount, 1);
  assert.deepEqual(published, [{ type: "agent.started", runId: "root-run" }]);
  bridge.dispose();
  assert.equal(second.unsubscribeCount, 1);
});

function createBridge(runId = "root-run"): PiSessionEventBridge {
  return new PiSessionEventBridge({
    runId: () => runId,
    publish: () => undefined,
  });
}

class FakeSource implements SessionEventSource {
  listener: ((event: AgentSessionEvent) => void) | undefined;
  unsubscribeCount = 0;

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribeCount += 1;
      this.listener = undefined;
    };
  }

  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }
}
