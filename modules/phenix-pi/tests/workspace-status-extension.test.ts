import assert from "node:assert/strict";
import test from "node:test";

import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import { formatWorkspaceGenericStatus } from "../extension/workspace-status-extension.ts";

const healthy = summary(0, 0);

test("renders selected model and healthy Phenix state", () => {
  assert.equal(
    formatWorkspaceGenericStatus({
      model: { provider: "openai", id: "gpt-5.6" },
      diagnostics: healthy,
      integrations: "5/5 loaded",
    }),
    "model openai/gpt-5.6 · phenix healthy",
  );
});

test("surfaces warning and terminal diagnostic health", () => {
  assert.equal(
    formatWorkspaceGenericStatus({ diagnostics: summary(0, 3), integrations: "5/5 loaded" }),
    "model none · phenix degraded (3)",
  );
  assert.equal(
    formatWorkspaceGenericStatus({ diagnostics: summary(2, 4), integrations: "5/5 loaded" }),
    "model none · phenix error (2)",
  );
});

test("treats failed integrations as degraded and missing runtime data as starting", () => {
  assert.equal(
    formatWorkspaceGenericStatus({
      diagnostics: healthy,
      integrations: "4/5 loaded; failed: lsp",
    }),
    "model none · phenix degraded",
  );
  assert.equal(formatWorkspaceGenericStatus({}), "model none · phenix starting");
});

function summary(errors: number, warnings: number): DiagnosticSummary {
  return {
    total: errors + warnings,
    artifacts: 0,
    counts: {
      trace: 0,
      info: 0,
      warning: warnings,
      error: errors,
    },
  };
}
