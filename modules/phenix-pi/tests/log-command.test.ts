import assert from "node:assert/strict";
import test from "node:test";

import { runId } from "../domain/shared.ts";
import {
  formatDiagnosticEntry,
  parseLogsCommand,
  PHENIX_LOGS_USAGE,
} from "../extension/log-command.ts";

const ROOT = runId("root-logs");

test("log command parsing applies severity thresholds and export destinations", () => {
  assert.deepEqual(parseLogsCommand(""), { kind: "show", minimum: "info", json: false });
  assert.deepEqual(parseLogsCommand("--trace"), {
    kind: "show",
    minimum: "trace",
    json: false,
  });
  assert.deepEqual(parseLogsCommand("--warning --json"), {
    kind: "show",
    minimum: "warning",
    json: true,
  });
  assert.deepEqual(parseLogsCommand("--warn --copy"), {
    kind: "copy",
    minimum: "warning",
    command: "wl-copy",
  });
  assert.deepEqual(parseLogsCommand("--error --copy xclip -selection clipboard"), {
    kind: "copy",
    minimum: "error",
    command: "xclip -selection clipboard",
  });
  assert.deepEqual(parseLogsCommand('--trace --file "reports/trace log.jsonl"'), {
    kind: "file",
    minimum: "trace",
    file: "reports/trace log.jsonl",
  });
  assert.deepEqual(parseLogsCommand("--resolve artifact:sha256:abc"), {
    kind: "resolve",
    reference: "artifact:sha256:abc",
  });
  assert.equal(parseLogsCommand("--trace --error"), undefined);
  assert.equal(parseLogsCommand("--unknown"), undefined);
  assert.match(PHENIX_LOGS_USAGE, /--trace\|--info\|--warning/);
});

test("formatted logs retain stable grepable scopes and flattened fields", () => {
  const text = formatDiagnosticEntry({
    version: 1,
    timestamp: "2026-07-24T05:18:53.114Z",
    severity: "warning",
    scope: "model.routing.candidate_failed",
    message: "Concrete model request failed",
    rootRunId: ROOT,
    runId: runId("run-implementer"),
    fields: {
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      status: 400,
      error: { ref: "artifact:sha256:deadbeef" },
    },
  });

  assert.match(text, /WARN model\.routing\.candidate_failed/);
  assert.match(text, /provider="opencode-go"/);
  assert.match(text, /model="kimi-k2\.7-code"/);
  assert.match(text, /error\.ref="artifact:sha256:deadbeef"/);
});
