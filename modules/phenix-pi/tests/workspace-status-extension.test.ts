import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkspaceGenericStatus } from "../extension/workspace-status-extension.ts";

test("renders only the selected model in the global workspace status", () => {
  assert.equal(
    formatWorkspaceGenericStatus({
      model: { provider: "openai", id: "gpt-5.6" },
    }),
    "model openai/gpt-5.6",
  );
});

test("uses one model fallback without projecting sidebar health", () => {
  const status = formatWorkspaceGenericStatus({});

  assert.equal(status, "model none");
  assert.doesNotMatch(status, /phenix|healthy|degraded|error|starting/);
});
