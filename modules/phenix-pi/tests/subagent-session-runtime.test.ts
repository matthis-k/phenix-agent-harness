import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelSetId } from "../extensions/phenix-kernel/ids.ts";
import {
  createSubagentSessionRuntime,
  routing,
  SubagentSessionPlanner,
  type SubagentSessionBindings,
} from "../extensions/phenix-runtime/child-session-backend.ts";
import {
  childRunId,
  type ChildCycleOutcome,
  type ChildRun,
  type ChildSessionBackend,
  type ChildSessionEvent,
  type ChildSessionNode,
  type ChildSessionSpec,
} from "../extensions/phenix-runtime/child-session-types.ts";

const bindings = {
  id: childRunId("child-session-runtime-test"),
  rootId: childRunId("child-session-runtime-test"),
  handleId: "handle-test",
  cwd: "/tmp/phenix-session-runtime-test",
  contract: { id: "contract-test" },
  workflowProjection: { options: [] },
  contractChannel: {},
  parentContext: {},
  effectiveTools: ["read"],
  skillRefs: [],
  extensionRefs: [],
  inheritProjectContext: true,
  timeoutMs: 1_000,
  turnBudget: {},
  toolBudget: {},
} as unknown as SubagentSessionBindings;

const defaults = {
  agent: "implementer" as const,
  modelSet: modelSetId("mixed"),
  difficulty: "D2" as const,
  thinking: "medium" as const,
  persistence: "file" as const,
};

class FakeRun implements ChildRun {
  readonly id = bindings.id;
  readonly backend = "sdk" as const;
  readonly pi = { sessionId: "pi-test" };

  snapshot(): ChildSessionNode {
    throw new Error("not used");
  }

  subscribe(_listener: (event: ChildSessionEvent) => void): () => void {
    return () => {};
  }

  async continue(_message: string, _signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return { cycle: 1, status: "settled" };
  }

  async waitForCurrentCycle(_signal?: AbortSignal): Promise<ChildCycleOutcome> {
    return { cycle: 1, status: "settled" };
  }

  async abort(_reason: string): Promise<void> {}

  async dispose(): Promise<void> {}
}

class RecordingBackend implements ChildSessionBackend {
  readonly kind = "sdk" as const;
  readonly run = new FakeRun();
  spec?: ChildSessionSpec;
  signal?: AbortSignal;

  async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
    this.spec = spec;
    this.signal = signal;
    return this.run;
  }
}

describe("SubagentSessionPlanner", () => {
  it("translates declarative session options into a complete backend spec", async () => {
    const planner = new SubagentSessionPlanner(async (request) => {
      assert.deepEqual(request, {
        modelSet: modelSetId("mixed"),
        agent: "scout",
        difficulty: "D2",
      });
      return {
        model: { provider: "opencode-go", id: "deepseek-v4-flash" },
        thinking: "low",
      };
    });

    const spec = await planner.plan({
      task: "Inspect the repository boundary.",
      session: {
        agent: "planner",
        model: routing.get("scout"),
        thinking: "high",
      },
      defaults,
      bindings,
    });

    assert.equal(spec.role, "planner");
    assert.deepEqual(spec.agentClient, { kind: "agent-client", id: "planner" });
    assert.deepEqual(spec.model, {
      provider: "opencode-go",
      id: "deepseek-v4-flash",
    });
    assert.equal(spec.thinkingLevel, "high");
    assert.equal(spec.initialPrompt, "Inspect the repository boundary.");
    assert.equal(spec.persistence, "file");
    assert.equal(spec.contract, bindings.contract);
    assert.equal(spec.workflowProjection, bindings.workflowProjection);
  });

  it("keeps the base agent explicit and bypasses routing for concrete models", async () => {
    let routed = false;
    const planner = new SubagentSessionPlanner(async () => {
      routed = true;
      throw new Error("routing must not be used");
    });

    const spec = await planner.plan({
      task: "Return a bounded result.",
      session: {
        agent: null,
        model: routing.concrete("openai-codex", "gpt-5.4-mini"),
        persistence: "memory",
      },
      defaults,
      bindings,
    });

    assert.equal(routed, false);
    assert.equal(spec.role, null);
    assert.deepEqual(spec.agentClient, { kind: "agent-client", id: "base" });
    assert.deepEqual(spec.model, {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
    });
    assert.equal(spec.persistence, "memory");
  });

  it("rejects an empty task before consulting routing", async () => {
    let routed = false;
    const planner = new SubagentSessionPlanner(async () => {
      routed = true;
      throw new Error("not reached");
    });

    await assert.rejects(
      planner.plan({ task: "   ", defaults, bindings }),
      /task must be non-empty/,
    );
    assert.equal(routed, false);
  });
});

describe("SubagentSessionRuntime", () => {
  it("plans and spawns through the backend port", async () => {
    const backend = new RecordingBackend();
    const runtime = createSubagentSessionRuntime({
      backend,
      resolveRoute: async () => ({
        model: { provider: "opencode-go", id: "mimo-v2.5" },
        thinking: "medium",
      }),
    });
    const controller = new AbortController();

    const run = await runtime.spawn(
      {
        task: "Scout the runtime implementation.",
        session: { agent: "scout" },
        defaults,
        bindings,
      },
      controller.signal,
    );

    assert.equal(run, backend.run);
    assert.equal(backend.signal, controller.signal);
    assert.equal(backend.spec?.role, "scout");
    assert.deepEqual(backend.spec?.model, {
      provider: "opencode-go",
      id: "mimo-v2.5",
    });
  });
});
