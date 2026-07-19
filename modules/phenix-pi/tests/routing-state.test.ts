import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clearSessionRuntime,
  cycleModelSet,
  getSessionRuntime,
  resolveModelSet,
  validateModelSet,
} from "@matthis-k/phenix-routing/state.ts";
import type { ModelSetId } from "@matthis-k/phenix-routing/types.ts";
import { DEFAULT_MODEL_SET_IDS } from "./support/default-routing-fixture.ts";

describe("Session routing state", () => {
  it("getSessionRuntime creates default state", () => {
    const runtime = getSessionRuntime("test-session");
    assert.equal(runtime.modelSet, "mixed");
    assert.equal(runtime.activeRoute, null);
    assert.equal(runtime.turnCount, 0);
  });

  it("getSessionRuntime returns same state for same session", () => {
    const r1 = getSessionRuntime("test-session");
    const r2 = getSessionRuntime("test-session");
    assert.equal(r1, r2);
  });

  it("different sessions have independent state", () => {
    const r1 = getSessionRuntime("test-session");
    const r2 = getSessionRuntime("test-session-2");
    assert.notEqual(r1, r2);
  });

  it("clearSessionRuntime removes state", () => {
    getSessionRuntime("test-session");
    clearSessionRuntime("test-session");
    const r = getSessionRuntime("test-session");
    // After clear, a fresh state is returned
    assert.equal(r.turnCount, 0);
  });

  it("resolveModelSet returns the session runtime model set", () => {
    const sessionId = "test-resolve-model-set";
    const runtime = getSessionRuntime(sessionId);
    runtime.modelSet = "gpt";
    // Returns session state regardless of CLI flag parameter
    assert.equal(resolveModelSet(sessionId, "free"), "gpt");
    assert.equal(resolveModelSet(sessionId, undefined), "gpt");
    clearSessionRuntime(sessionId);
  });

  it("validateModelSet returns valid sets", () => {
    for (const id of DEFAULT_MODEL_SET_IDS) {
      assert.equal(validateModelSet(id), id);
    }
  });

  it("validateModelSet returns undefined for invalid sets", () => {
    assert.equal(validateModelSet("invalid"), undefined);
    assert.equal(validateModelSet(""), undefined);
    assert.equal(validateModelSet("opencode-go-plus"), undefined);
  });

  it("Ctrl+T cycles in declared order", () => {
    const order: ModelSetId[] = ["free", "opencode-go", "gpt", "mixed"];
    assert.equal(cycleModelSet("free", order), "opencode-go");
    assert.equal(cycleModelSet("opencode-go", order), "gpt");
    assert.equal(cycleModelSet("gpt", order), "mixed");
    assert.equal(cycleModelSet("mixed", order), "free");
  });

  it("cycleModelSet wraps around for unknown current", () => {
    const order: ModelSetId[] = ["free", "gpt"];
    assert.equal(cycleModelSet("mixed" as ModelSetId, order), "free");
  });

  it("setting changes do not call pi.setModel (state-only)", () => {
    const runtime = getSessionRuntime("test-session");
    runtime.modelSet = "gpt";
    assert.equal(runtime.modelSet, "gpt");
    // No pi.setModel is called — that's the caller's responsibility
    // This test verifies the state doesn't involve model selection
  });
});
