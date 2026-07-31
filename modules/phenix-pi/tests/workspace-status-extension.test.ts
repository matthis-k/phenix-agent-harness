import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkspaceGenericStatus } from "../extension/workspace-status-extension.ts";

test("renders only the concrete selected model", () => {
  assert.equal(
    formatWorkspaceGenericStatus({
      model: { provider: "openai", id: "gpt-5.6" },
    }),
    "model openai/gpt-5.6",
  );
});

test("renders an explicit empty model state", () => {
  assert.equal(formatWorkspaceGenericStatus({}), "model none");
});
