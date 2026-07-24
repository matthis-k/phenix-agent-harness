import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlDiagnosticLog } from "../adapters/persistence/jsonl-diagnostic-log.ts";
import { runId } from "../domain/shared.ts";

const ROOT = runId("root-diagnostics");

test("diagnostics persist private JSONL, filter by threshold, and reference large payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-diagnostics-"));
  const log = new JsonlDiagnosticLog(directory);
  const observed: string[] = [];
  const unsubscribe = log.subscribe((entry) => {
    observed.push(entry.scope);
  });
  try {
    await log.record({
      rootRunId: ROOT,
      runId: ROOT,
      severity: "trace",
      scope: "tool.execution.started",
      message: "Tool started",
      fields: { toolName: "read" },
    });
    const warning = await log.record({
      rootRunId: ROOT,
      runId: ROOT,
      severity: "warning",
      scope: "provider.request.failed",
      message: "Provider failed Authorization: Bearer raw-message-token",
      fields: {
        apiKey: "must-not-be-written",
        context: "x".repeat(2_000),
        status: 400,
        response: { accessToken: "raw-nested-token", requestId: "request-1" },
      },
    });

    assert.deepEqual(observed, ["tool.execution.started", "provider.request.failed"]);
    assert.equal((await stat(log.pathFor(ROOT))).mode & 0o777, 0o600);
    const raw = await readFile(log.pathFor(ROOT), "utf8");
    assert.equal(raw.includes("must-not-be-written"), false);
    assert.equal(raw.includes("raw-message-token"), false);
    assert.equal(raw.includes("raw-nested-token"), false);
    assert.equal(raw.includes("[redacted]"), true);

    const warnings = await log.entries(ROOT, "warning");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.scope, "provider.request.failed");
    assert.equal(warnings[0]?.message, "Provider failed Authorization: <redacted>");
    assert.equal((await log.entries(ROOT, "error")).length, 0);

    const fields = warning.fields as {
      readonly context: { readonly ref: string; readonly bytes: number };
      readonly response: { readonly accessToken: string; readonly requestId: string };
    };
    assert.equal(fields.response.accessToken, "[redacted]");
    assert.equal(fields.response.requestId, "request-1");
    assert.match(fields.context.ref, /^artifact:sha256:[a-f0-9]{64}$/);
    assert.equal(fields.context.bytes, 2_000);
    assert.equal(await log.resolve(ROOT, fields.context.ref), "x".repeat(2_000));

    const summary = await log.summary(ROOT);
    assert.equal(summary.total, 2);
    assert.equal(summary.artifacts, 1);
    assert.equal(summary.counts.trace, 1);
    assert.equal(summary.counts.warning, 1);
    assert.equal((await log.export(ROOT, "warning")).trim().split("\n").length, 1);

    const reloaded = new JsonlDiagnosticLog(directory);
    assert.equal((await reloaded.entries(ROOT, "trace")).length, 2);
    assert.equal((await reloaded.summary(ROOT)).total, 2);
  } finally {
    unsubscribe();
    await rm(directory, { recursive: true, force: true });
  }
});
