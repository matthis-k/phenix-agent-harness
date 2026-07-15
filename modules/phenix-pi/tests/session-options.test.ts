import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelSetId } from "../extensions/phenix-kernel/ids.ts";
import {
  resolveSubagentSessionOptions,
  routing,
  type SessionRouteRequest,
  type SessionRouteResolver,
} from "../extensions/phenix-runtime/child-session-backend.ts";

const defaults = {
  agent: "implementer" as const,
  modelSet: modelSetId("mixed"),
  difficulty: "D2" as const,
  thinking: "medium" as const,
  persistence: "file" as const,
};

describe("subagent session options", () => {
  it("builds a declarative routed selector without resolving it eagerly", () => {
    const selector = routing.get("scout", {
      modelSet: modelSetId("free"),
      difficulty: "D1",
    });

    assert.deepEqual(selector, {
      kind: "route",
      agent: "scout",
      modelSet: modelSetId("free"),
      difficulty: "D1",
    });
  });

  it("resolves omitted models through the injected routing table", async () => {
    const requests: SessionRouteRequest[] = [];
    const resolveRoute: SessionRouteResolver = async (request) => {
      requests.push(request);
      return {
        model: { provider: "opencode-go", id: "deepseek-v4-flash" },
        thinking: "low",
      };
    };

    const resolved = await resolveSubagentSessionOptions({
      session: { agent: "scout" },
      defaults,
      resolveRoute,
    });

    assert.deepEqual(requests, [
      {
        modelSet: modelSetId("mixed"),
        agent: "scout",
        difficulty: "D2",
      },
    ]);
    assert.deepEqual(resolved, {
      agent: "scout",
      model: { provider: "opencode-go", id: "deepseek-v4-flash" },
      thinking: "low",
      persistence: "file",
      route: {
        modelSet: modelSetId("mixed"),
        agent: "scout",
        difficulty: "D2",
      },
    });
  });

  it("allows a routed model to use a different role while preserving the session agent", async () => {
    const resolveRoute: SessionRouteResolver = async (request) => {
      assert.equal(request.agent, "scout");
      return {
        model: { provider: "openai-codex", id: "gpt-5.4-mini" },
        thinking: "minimal",
      };
    };

    const resolved = await resolveSubagentSessionOptions({
      session: {
        agent: "planner",
        model: routing.get("scout"),
        thinking: "high",
      },
      defaults,
      resolveRoute,
    });

    assert.equal(resolved.agent, "planner");
    assert.equal(resolved.route?.agent, "scout");
    assert.equal(resolved.thinking, "high");
  });

  it("uses concrete models without consulting routing", async () => {
    let routed = false;
    const resolved = await resolveSubagentSessionOptions({
      session: {
        agent: null,
        model: routing.concrete("openai-codex", "gpt-5.4"),
        persistence: "memory",
      },
      defaults,
      resolveRoute: async () => {
        routed = true;
        throw new Error("routing must not run for a concrete model");
      },
    });

    assert.equal(routed, false);
    assert.deepEqual(resolved, {
      agent: null,
      model: { provider: "openai-codex", id: "gpt-5.4" },
      thinking: "medium",
      persistence: "memory",
    });
  });

  it("rejects empty concrete model references at construction", () => {
    assert.throws(() => routing.concrete("", "model"), /provider must be non-empty/);
    assert.throws(() => routing.concrete("provider", ""), /model ID must be non-empty/);
  });
});
