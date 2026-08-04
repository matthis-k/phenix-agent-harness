import assert from "node:assert/strict";
import test from "node:test";

import {
  HeadlessCommandSchema,
  HeadlessRequestFrameSchema,
  parseHeadlessRequest,
} from "../headless/protocol.ts";

test("request parser accepts a typed authentication response", () => {
  const frame = parseHeadlessRequest({
    kind: "request",
    id: "request-1",
    command: {
      type: "auth.login.respond",
      flowId: "flow-1",
      response: { kind: "secret", value: "not-logged-by-the-protocol" },
    },
  });

  assert.equal(frame.command.type, "auth.login.respond");
});

test("command schema rejects unknown commands and extra properties", () => {
  assert.equal(HeadlessCommandSchema.validate({ type: "unknown" }).ok, false);
  assert.equal(HeadlessCommandSchema.validate({ type: "model.list", accidental: true }).ok, false);
});

test("request schema rejects control characters in durable IDs", () => {
  const result = HeadlessRequestFrameSchema.validate({
    kind: "request",
    id: "request\nother",
    command: { type: "model.list" },
  });
  assert.equal(result.ok, false);
});

test("prompt command targets a Phenix run and validates streaming input", () => {
  const result = HeadlessCommandSchema.validate({
    type: "prompt.submit",
    runId: "root-run",
    text: "inspect",
    images: [{ mediaType: "image/png", data: "AA==" }],
    streamingBehavior: "steer",
  });
  assert.equal(result.ok, true);
});

test("prompt command rejects persisted session IDs as the target field", () => {
  const result = HeadlessCommandSchema.validate({
    type: "prompt.submit",
    sessionId: "session-1",
    text: "inspect",
    images: [],
  });
  assert.equal(result.ok, false);
});
