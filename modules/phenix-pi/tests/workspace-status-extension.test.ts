import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import registerWorkspaceStatus, {
  formatWorkspaceGenericStatus,
} from "../extension/workspace-status-extension.ts";

test("registration defers runtime action reads until session start", () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const statuses: Array<readonly [string, string | undefined]> = [];
  let initialized = false;
  let thinkingReads = 0;

  const pi = {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => {
      thinkingReads += 1;
      if (!initialized) throw new Error("Extension runtime not initialized");
      return "high";
    },
  } as unknown as ExtensionAPI;

  assert.doesNotThrow(() => registerWorkspaceStatus(pi));
  assert.equal(thinkingReads, 0);

  initialized = true;
  const context = {
    model: { provider: "openai", id: "gpt-5.6" },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        statuses.push([key, value]);
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, context);

  assert.equal(thinkingReads, 1);
  assert.deepEqual(statuses.at(-1), ["00-workspace", "openai/gpt-5.6 · thinking high"]);
});

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
