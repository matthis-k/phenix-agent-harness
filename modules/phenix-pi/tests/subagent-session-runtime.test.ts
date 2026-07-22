import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import {
  createSubagentSessionRuntime,
  type RuntimeBindings,
  returns,
  routing,
  type SubagentExecutionPlan,
  SubagentSessionPlanner,
} from "@matthis-k/phenix-suite/runtime/child-session-backend.ts";
import {
  type ChildCycleOutcome,
  type ChildRun,
  type ChildSessionBackend,
  type ChildSessionEvent,
  type ChildSessionNode,
  type ChildSessionSpec,
  childRunId,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";

const runtime = {
  id: childRunId("child-session-runtime-test"),
  rootId: childRunId("child-session-runtime-test"),
  handleId: "handle-test",
  cwd: "/tmp/phenix-session-runtime-test",
  contract: {
    id: "contract-test",
    identity: { role: "implementer" },
    assignment: {
      task: "Inspect the repository boundary.",
      requirements: [],
    },
    runtime: {
      workflow: { difficulty: "D2" },
    },
    verification: {
      commands: [],
      criticRequired: true,
      maxRepairAttempts: 1,
    },
  },
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
} as unknown as RuntimeBindings;

const defaults = {
  agent: "implementer" as const,
  modelSet: modelSetId("mixed"),
  difficulty: "D2" as const,
  thinking: "medium" as const,
  persistence: "file" as const,
};

function executionPlan(
  session: SubagentExecutionPlan<unknown>["session"] = { defaults },
): SubagentExecutionPlan<unknown> {
  return {
    assignment: {
      task: "Inspect the repository boundary.",
      requirements: [],
    },
    session,
    runtime,
    acceptance: {
      kind: "test",
      returns: returns({ type: "object" }),
    },
  };
}

class FakeRun implements ChildRun {
  readonly id = runtime.id;
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
  it("translates one canonical plan into a backend spec", async () => {
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

    const spec = await planner.plan(
      executionPlan({
        defaults,
        options: {
          agent: "planner",
          model: routing.get("scout"),
          thinking: "high",
        },
      }),
    );

    assert.equal(spec.role, "planner");
    assert.deepEqual(spec.agentClient, { kind: "agent-client", id: "planner" });
    assert.deepEqual(spec.model, {
      provider: "opencode-go",
      id: "deepseek-v4-flash",
    });
    assert.equal(spec.thinkingLevel, "high");
    assert.equal(spec.initialPrompt, "Inspect the repository boundary.");
    assert.equal(spec.persistence, "file");
    assert.equal(spec.contract, runtime.contract);
    assert.equal(spec.assurance, "A2");
    assert.equal(spec.isolationRequired, false);
  });

  it("keeps the base agent explicit for a concrete model", async () => {
    let routed = false;
    const planner = new SubagentSessionPlanner(async () => {
      routed = true;
      throw new Error("routing must not be used");
    });

    const spec = await planner.plan(
      executionPlan({
        defaults,
        options: {
          agent: null,
          model: routing.concrete("openai-codex", "gpt-5.4-mini"),
          persistence: "memory",
        },
      }),
    );

    assert.equal(routed, false);
    assert.equal(spec.role, null);
    assert.deepEqual(spec.agentClient, { kind: "agent-client", id: "base" });
    assert.equal(spec.persistence, "memory");
  });
});

describe("SubagentSessionRuntime", () => {
  it("starts the backend from the same canonical plan", async () => {
    const backend = new RecordingBackend();
    const sessions = createSubagentSessionRuntime({
      backend,
      resolveRoute: async () => ({
        model: { provider: "opencode-go", id: "mimo-v2.5" },
        thinking: "medium",
      }),
    });
    const controller = new AbortController();

    const run = await sessions.spawn(
      executionPlan({ defaults, options: { agent: "scout" } }),
      controller.signal,
    );

    assert.equal(run, backend.run);
    assert.equal(backend.signal, controller.signal);
    assert.equal(backend.spec?.role, "scout");
    assert.deepEqual(backend.spec?.model, {
      provider: "opencode-go",
      id: "mimo-v2.5",
    });
    assert.equal(backend.spec?.assurance, "A2");
    assert.equal(backend.spec?.isolationRequired, false);
  });
});
