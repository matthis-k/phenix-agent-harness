import assert from "node:assert/strict";
import test from "node:test";

import { formatWorkspaceGenericStatus } from "../extension/workspace-status-extension.ts";

test("direct models show provider, model, and thinking mode only", () => {
  const status = formatWorkspaceGenericStatus({
    model: { provider: "openai", id: "gpt-5.6" },
    thinking: "high",
  });

  assert.equal(status, "openai/gpt-5.6 · thinking high");
  assert.doesNotMatch(status, /phenix\/router|budget/);
});

test("Phenix-routed models show router and budget mode only", () => {
  const status = formatWorkspaceGenericStatus({
    model: { provider: "phenix", id: "mixed" },
    thinking: "xhigh",
  });

  assert.equal(status, "phenix/router · budget xhigh");
  assert.doesNotMatch(status, /mixed|thinking/);
});

test("uses one direct-model fallback without projecting sidebar health", () => {
  const status = formatWorkspaceGenericStatus({ thinking: "off" });

  assert.equal(status, "model none · thinking off");
  assert.doesNotMatch(status, /phenix|healthy|degraded|error|starting|budget/);
});
