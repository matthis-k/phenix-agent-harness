import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearStreamTraceSession,
  createStreamTraceContext,
  newStreamTraceId,
  registerStreamTraceSink,
  runWithStreamTraceContext,
  streamTraceEnabled,
  streamTraceIdForSession,
  streamTraceMessageFields,
  writeStreamTrace,
} from "@matthis-k/phenix-routing/stream-trace.ts";

test("stream tracing is inert when disabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "phenix-trace-disabled-"));
  const tracePath = join(directory, "trace.jsonl");
  const previous = process.env.PHENIX_PI_STREAM_TRACE;
  delete process.env.PHENIX_PI_STREAM_TRACE;
  try {
    writeStreamTrace({ boundary: "test", secret: "must-not-be-written" });
    assert.equal(existsSync(tracePath), false);
  } finally {
    if (previous === undefined) delete process.env.PHENIX_PI_STREAM_TRACE;
    else process.env.PHENIX_PI_STREAM_TRACE = previous;
    rmSync(directory, { recursive: true });
  }
});

test("stream tracing appends correlated valid JSONL", () => {
  const directory = mkdtempSync(join(tmpdir(), "phenix-trace-enabled-"));
  const tracePath = join(directory, "nested", "trace.jsonl");
  const previous = process.env.PHENIX_PI_STREAM_TRACE;
  process.env.PHENIX_PI_STREAM_TRACE = tracePath;
  try {
    writeStreamTrace({ boundary: "pi_ingress", traceId: "trace-test", ingressSequence: 1 });
    writeStreamTrace({
      boundary: "router_egress",
      traceId: "trace-test",
      ingressSequence: 1,
      egressSequence: 1,
    });
    const records = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.traceId),
      ["trace-test", "trace-test"],
    );
    assert.deepEqual(
      records.map((record) => record.ingressSequence),
      [1, 1],
    );
    assert.ok(records.every((record) => typeof record.pid === "number"));
    assert.equal(readFileSync(tracePath, "utf8").includes("authorization"), false);
  } finally {
    if (previous === undefined) delete process.env.PHENIX_PI_STREAM_TRACE;
    else process.env.PHENIX_PI_STREAM_TRACE = previous;
    rmSync(directory, { recursive: true });
  }
});

test("an in-process sink enables correlated tracing without a second trace file", () => {
  const previous = process.env.PHENIX_PI_STREAM_TRACE;
  delete process.env.PHENIX_PI_STREAM_TRACE;
  const records: Readonly<Record<string, unknown>>[] = [];
  const unsubscribe = registerStreamTraceSink((record) => records.push(record));
  const context = createStreamTraceContext("root-session");
  try {
    assert.equal(streamTraceEnabled(), true);
    runWithStreamTraceContext(context, () => {
      writeStreamTrace({ boundary: "root_tool_call", toolName: "phenix_workflow" });
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sessionId, "root-session");
    assert.equal(records[0]?.traceId, context.traceId);
    assert.equal(records[0]?.boundary, "root_tool_call");
    assert.equal(typeof records[0]?.timestamp, "string");
  } finally {
    unsubscribe();
    clearStreamTraceSession("root-session");
    if (previous === undefined) delete process.env.PHENIX_PI_STREAM_TRACE;
    else process.env.PHENIX_PI_STREAM_TRACE = previous;
  }
});

test("provider trace context supplies the router trace id", () => {
  const sessionId = "trace-context-session";
  const context = createStreamTraceContext(sessionId);
  try {
    const routerTraceId = runWithStreamTraceContext(context, () => newStreamTraceId());
    assert.equal(routerTraceId, context.traceId);
    assert.equal(streamTraceIdForSession(sessionId), context.traceId);
  } finally {
    clearStreamTraceSession(sessionId);
  }
  assert.equal(streamTraceIdForSession(sessionId), undefined);
});

test("message summaries expose hashes and lengths instead of full content", () => {
  const longText = "duplicate-segment ".repeat(20);
  const fields = streamTraceMessageFields({
    role: "assistant",
    provider: "phenix",
    model: "free",
    responseId: "response-test",
    content: [
      { type: "text", text: longText },
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
    ],
  });

  assert.equal(fields.visibleTextLength, longText.length);
  assert.equal(typeof fields.visibleTextSha256, "string");
  assert.deepEqual(fields.contentBlockTypes, ["text", "thinking", "toolCall"]);
  assert.equal(JSON.stringify(fields).includes(longText), false);
  assert.equal(JSON.stringify(fields).includes("private reasoning"), false);
});
