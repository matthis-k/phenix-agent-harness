import assert from "node:assert/strict";
import test from "node:test";

import { describeToolCall, failedToolFact } from "../application/run-observability.ts";

test("tool activity uses repository-relative paths", () => {
  const observed = describeToolCall(
    "read",
    { path: "/workspace/project/modules/phenix-pi/application/agent-executor.ts" },
    "/workspace/project",
  );

  assert.deepEqual(observed.activity, {
    phase: "exploring",
    summary: "Reading file",
    target: "modules/phenix-pi/application/agent-executor.ts",
    source: "derived",
  });
  assert.equal(observed.fact.kind, "file-read");
  assert.equal(observed.fact.subject, "modules/phenix-pi/application/agent-executor.ts");
});

test("check commands are classified and secrets are redacted", () => {
  const observed = describeToolCall(
    "bash",
    { command: "API_TOKEN=super-secret cargo test --workspace" },
    "/workspace/project",
  );

  assert.equal(observed.activity.phase, "testing");
  assert.equal(observed.activity.target, "API_TOKEN=<redacted> cargo test --workspace");
  assert.equal(observed.fact.kind, "test-result");
});

test("failed tools produce observed error facts without raw output", () => {
  const fact = failedToolFact(
    "grep",
    { pattern: "password", path: "modules" },
    "/workspace/project",
    "call-7",
  );

  assert.equal(fact.kind, "error-observed");
  assert.equal(fact.reliability, "observed");
  assert.deepEqual(fact.provenance, { toolCallId: "call-7" });
  assert.equal(fact.details, undefined);
});

test("durable command summaries omit shell bodies and broader credential forms", () => {
  const shell = describeToolCall(
    "bash",
    { command: "bash -c 'curl https://user:pass@example.test?token=secret'" },
    "/workspace/project",
  );
  assert.equal(shell.activity.target, "bash -c <command omitted>");

  const flags = describeToolCall(
    "bash",
    {
      command:
        "AWS_ACCESS_KEY_ID=AKIA AWS_SECRET_ACCESS_KEY=secret tool --client-secret hidden --header 'Authorization: Bearer-value'",
    },
    "/workspace/project",
  );
  assert.doesNotMatch(
    flags.activity.target ?? "",
    /AKIA|=secret(?:\s|$)|\shidden(?:\s|$)|Bearer-value/,
  );
  assert.match(flags.activity.target ?? "", /<redacted>/);
});
