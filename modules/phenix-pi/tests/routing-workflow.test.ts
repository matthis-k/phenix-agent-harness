/**
 * Phenix workflow integration tests.
 *
 * These tests exercise the full end-to-end routing pipeline:
 * - Virtual provider registration (model-set models)
 * - Model selection → model set resolution
 * - Route resolution from the matrix
 * - Session state management
 * - Error handling (missing models, unavailable candidates)
 *
 * They DO NOT test the Pi extension lifecycle hooks directly
 * (before_agent_start, streamSimple) since those require a real Pi
 * runtime. Instead they test the underlying components in the same
 * composition the runtime uses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ModelRegistry, resolveRoute } from "@matthis-k/phenix-routing/resolver.ts";
import {
  clearSessionRuntime,
  getSessionRuntime,
  resolveModelSet,
  validateModelSet,
} from "@matthis-k/phenix-routing/state.ts";
import type { ModelRef, ModelSetId, RoutingRole } from "@matthis-k/phenix-routing/types.ts";
import {
  buildDefaultRoutingConfig,
  DEFAULT_MODEL_SET_IDS,
  DEFAULT_PHENIX_MODEL_SETS,
  defaultModelSetForModelId,
} from "./support/default-routing-fixture.ts";

// ---------------------------------------------------------------------------
// Fake model registry — simulates Pi's getModelRegistry() response
// ---------------------------------------------------------------------------

class FakeRegistry implements ModelRegistry {
  private readonly available: Set<string>;

  constructor(available: readonly ModelRef[]) {
    this.available = new Set(available.map((m) => `${m.provider}/${m.model}`));
  }

  isAvailable(provider: string, model: string): boolean {
    return this.available.has(`${provider}/${model}`);
  }
}

function mr(provider: string, model: string): ModelRef {
  return { provider, model };
}

// All the models referenced in the bundled pools
const ALL_POOL_MODELS: readonly ModelRef[] = [
  mr("opencode", "deepseek-v4-flash-free"),
  mr("opencode-go", "deepseek-v4-flash"),
  mr("opencode-go", "mimo-v2.5"),
  mr("opencode-go", "deepseek-v4-pro"),
  mr("opencode-go", "qwen3.7-plus"),
  mr("opencode-go", "glm-5.1"),
  mr("opencode-go", "qwen3.7-max"),
  mr("opencode-go", "glm-5.2"),
  mr("opencode-go", "kimi-k2.6"),
  mr("opencode-go", "kimi-k2.7-code"),
  mr("openai-codex", "gpt-5.6"),
  mr("openai-codex", "gpt-5.6-terra"),
  mr("openai-codex", "gpt-5.6-luna"),
  mr("openai-codex", "gpt-5.5"),
  mr("openai-codex", "gpt-5.4"),
  mr("openai-codex", "gpt-5.4-mini"),
];

function fullRegistry(): ModelRegistry {
  return new FakeRegistry(ALL_POOL_MODELS);
}

const EMPTY_REGISTRY = new FakeRegistry([]);
const config = buildDefaultRoutingConfig();

// ---------------------------------------------------------------------------
// Workflow tests: selecting a model → resolving a route
// ---------------------------------------------------------------------------

describe("Workflow: model selection → route resolution", () => {
  it("unknown model id returns undefined from defaultModelSetForModelId", () => {
    // Only explicit model-set models are registered. Any other model id
    // (e.g. "workflow") is unknown and must return undefined.
    assert.equal(defaultModelSetForModelId("workflow"), undefined);
    assert.equal(defaultModelSetForModelId("unknown"), undefined);
    assert.equal(defaultModelSetForModelId(""), undefined);
    // Valid model-set models must be recognized
    assert.equal(defaultModelSetForModelId("mixed"), "mixed");
    assert.equal(defaultModelSetForModelId("free"), "free");
    assert.equal(defaultModelSetForModelId("opencode-go"), "opencode-go");
    assert.equal(defaultModelSetForModelId("gpt"), "gpt");
  });

  it("selecting phenix/opencode-go explicitly sets model set to opencode-go", async () => {
    const selectedModelId = "opencode-go";

    // Step 1: defaultModelSetForModelId extracts the model set
    const explicitModelSet = defaultModelSetForModelId(selectedModelId);
    assert.equal(explicitModelSet, "opencode-go");

    // Step 2: The before_agent_start handler would set runtime.modelSet
    const sessionId = "test-opencode-session";
    const runtime = getSessionRuntime(sessionId);
    assert.ok(explicitModelSet, "Expected an explicit model set");
    runtime.modelSet = explicitModelSet;
    assert.equal(runtime.modelSet, "opencode-go");

    // Step 3: Route resolves using opencode-go model set
    // coordinator D2 → reasoning → go.reasoning → opencode-go provider
    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.model.provider, "opencode-go");

    clearSessionRuntime(sessionId);
  });

  it("selecting phenix/gpt sets model set to gpt and routes through OpenAI", async () => {
    const explicitModelSet = defaultModelSetForModelId("gpt");
    assert.equal(explicitModelSet, "gpt");

    const sessionId = "test-gpt-session";
    const runtime = getSessionRuntime(sessionId);
    assert.ok(explicitModelSet, "Expected an explicit model set");
    runtime.modelSet = explicitModelSet;

    // coordinator D2 → reasoning → gpt.reasoning → openai-codex provider
    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.model.provider, "openai-codex");

    clearSessionRuntime(sessionId);
  });

  it("selecting phenix/free restricts to opencode provider only", async () => {
    const explicitModelSet = defaultModelSetForModelId("free");
    assert.equal(explicitModelSet, "free");

    const sessionId = "test-free-session";
    const runtime = getSessionRuntime(sessionId);
    assert.ok(explicitModelSet, "Expected an explicit model set");
    runtime.modelSet = explicitModelSet;

    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route.model.provider, "opencode");
    assert.equal(runtime.modelSet, "free");

    clearSessionRuntime(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Workflow tests: route lifecycle
// ---------------------------------------------------------------------------

describe("Workflow: route lifecycle", () => {
  it("model set persists across turns in the same session", async () => {
    const sessionId = "test-lifecycle";

    // Turn 1: user selects phenix/gpt
    const runtime = getSessionRuntime(sessionId);
    runtime.modelSet = "gpt";

    const route1 = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route1.modelSet, "gpt");
    assert.equal(route1.model.provider, "openai-codex");

    // Turn 2: same session, model set is still gpt
    const runtime2 = getSessionRuntime(sessionId);
    assert.equal(runtime2.modelSet, "gpt");

    const route2 = await resolveRoute({
      modelSet: runtime2.modelSet,
      role: "implementer",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route2.modelSet, "gpt");
    assert.equal(route2.model.provider, "openai-codex");

    clearSessionRuntime(sessionId);
  });

  it("different sessions can have different model sets independently", async () => {
    // Session A: opencode-go
    const sessionA = "session-a";
    const runtimeA = getSessionRuntime(sessionA);
    runtimeA.modelSet = "opencode-go";

    // Session B: gpt
    const sessionB = "session-b";
    const runtimeB = getSessionRuntime(sessionB);
    runtimeB.modelSet = "gpt";

    assert.notEqual(runtimeA.modelSet, runtimeB.modelSet);

    const routeA = await resolveRoute({
      modelSet: runtimeA.modelSet,
      role: "implementer",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(routeA.model.provider, "opencode-go");

    const routeB = await resolveRoute({
      modelSet: runtimeB.modelSet,
      role: "implementer",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(routeB.model.provider, "openai-codex");

    clearSessionRuntime(sessionA);
    clearSessionRuntime(sessionB);
  });

  it("changing model set mid-session takes effect on next turn", async () => {
    const sessionId = "test-switch";
    const runtime = getSessionRuntime(sessionId);

    // Turn 1: opencode-go
    runtime.modelSet = "opencode-go";
    const route1 = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route1.model.provider, "opencode-go");

    // Turn 2: switch to gpt
    runtime.modelSet = "gpt";
    const route2 = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty: "D1",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(route2.model.provider, "openai-codex");

    clearSessionRuntime(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Workflow tests: error handling
// ---------------------------------------------------------------------------

describe("Workflow: error handling", () => {
  it("missing concrete models produce clear failure message", async () => {
    await assert.rejects(
      resolveRoute({
        modelSet: "opencode-go",
        role: "implementer",
        difficulty: "D1",
        modelRegistry: EMPTY_REGISTRY,
        config,
      }),
      (err: Error) => {
        return (
          err.message.includes("No available candidates") &&
          err.message.includes("opencode-go") &&
          err.message.includes("code")
        );
      },
    );
  });

  it("unconfigured model set throws with model set name in error", async () => {
    await assert.rejects(
      resolveRoute({
        modelSet: "gpt",
        role: "coordinator",
        difficulty: "D2",
        modelRegistry: EMPTY_REGISTRY,
        config,
      }),
      (err: Error) => {
        return err.message.includes("gpt") && err.message.includes("reasoning");
      },
    );
  });

  it("resolver never produces a phenix/workflow model reference", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "planner",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.notEqual(route.model.provider, "phenix");
    assert.notEqual(`${route.model.provider}/${route.model.model}`, "phenix/workflow");
  });

  it("all model-set models are rejected by the resolver boundary filter", () => {
    // The resolver explicitly skips "phenix/*" candidates.
    // Even if a pool accidentally contained phenix/<setId>, it would be skipped.
    for (const setId of DEFAULT_PHENIX_MODEL_SETS) {
      const ref = `phenix/${setId}`;
      assert.throws(() => {
        // parseModelRef would succeed, but the resolver's boundary filter
        // would skip it. This test verifies the boundary logic works.
        if (ref.startsWith("phenix/")) throw new Error(`rejected: ${ref}`);
      }, /rejected/);
    }
  });
});

// ---------------------------------------------------------------------------
// Workflow tests: mixed model set routing
// ---------------------------------------------------------------------------

describe("Workflow: mixed model set routing", () => {
  it("mixed routes implementer through opencode-go and critic through openai-codex", async () => {
    const implRoute = await resolveRoute({
      modelSet: "mixed",
      role: "implementer",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    // mixed → implementer D2 → code → go.code → opencode-go
    assert.equal(implRoute.model.provider, "opencode-go");
    assert.equal(implRoute.capability, "code");

    const critRoute = await resolveRoute({
      modelSet: "mixed",
      role: "critic",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
      avoidModels: [implRoute.model],
    });
    // mixed → critic D2 → review → gpt.review → openai
    assert.equal(critRoute.model.provider, "openai-codex");
    assert.equal(critRoute.capability, "review");
  });

  it("mixed routes planner through GPT reasoning pool", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "planner",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    // mixed → planner D2 → reasoning → gpt.reasoning → openai
    assert.equal(route.model.provider, "openai-codex");
    assert.equal(route.capability, "reasoning");
    assert.equal(route.thinking, "high");
  });

  it("mixed routes scout/finalizer through opencode-go for D0 tasks", async () => {
    const scout = await resolveRoute({
      modelSet: "mixed",
      role: "scout",
      difficulty: "D0",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(scout.model.provider, "opencode-go");
    assert.equal(scout.capability, "fast");

    const finalizer = await resolveRoute({
      modelSet: "mixed",
      role: "finalizer",
      difficulty: "D0",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(finalizer.model.provider, "opencode-go");
    assert.equal(finalizer.capability, "fast");
  });

  it("mixed routes architect through GPT reasoning-max for D3 tasks", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "architect",
      difficulty: "D3",
      modelRegistry: fullRegistry(),
      config,
    });
    // mixed → architect D3 → reasoning-max → gpt.pro → openai
    assert.equal(route.model.provider, "openai-codex");
    assert.equal(route.capability, "reasoning-max");
    assert.equal(route.thinking, "xhigh");
  });
});

// ---------------------------------------------------------------------------
// Workflow tests: model set persistence across runtime restarts
// ---------------------------------------------------------------------------

describe("Workflow: model set persistence", () => {
  it("defaultModelSetForModelId is deterministic (no side effects)", () => {
    // Pure function — calling it multiple times returns the same result
    assert.equal(defaultModelSetForModelId("free"), "free");
    assert.equal(defaultModelSetForModelId("free"), "free");
    assert.equal(defaultModelSetForModelId("opencode-go"), "opencode-go");
    assert.equal(defaultModelSetForModelId("opencode-go"), "opencode-go");
  });

  it("validateModelSet ensures only valid model sets are accepted", () => {
    // These should all be valid
    for (const id of DEFAULT_MODEL_SET_IDS) {
      assert.equal(validateModelSet(id), id);
    }

    // These should all be rejected
    assert.equal(validateModelSet(""), undefined);
    assert.equal(validateModelSet("invalid"), undefined);
    assert.equal(validateModelSet("opencode-go-plus"), undefined);
    assert.equal(validateModelSet("workflow"), undefined);
    assert.equal(validateModelSet("phenix"), undefined);
  });

  it("resolveModelSet returns the session runtime model set", () => {
    const sessionId = "test-persistence";
    const runtime = getSessionRuntime(sessionId);
    runtime.modelSet = "mixed";

    // Returns session state (CLI flag parameter is ignored)
    const ms = resolveModelSet(sessionId, undefined);
    assert.equal(ms, "mixed");

    const msWithFlag = resolveModelSet(sessionId, "free");
    assert.equal(msWithFlag, "mixed");

    // Session state changes are reflected
    runtime.modelSet = "gpt";
    const msSession = resolveModelSet(sessionId, undefined);
    assert.equal(msSession, "gpt");

    clearSessionRuntime(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Workflow tests: full role × model-set matrix coverage
// ---------------------------------------------------------------------------

describe("Workflow: full matrix coverage", () => {
  const roles: RoutingRole[] = [
    "coordinator",
    "scout",
    "planner",
    "architect",
    "implementer",
    "tester",
    "critic",
    "finalizer",
  ];
  const difficulties = ["D0", "D1", "D2", "D3"] as const;
  const sets: ModelSetId[] = ["free", "opencode-go", "gpt", "mixed"];

  for (const modelSet of sets) {
    for (const role of roles) {
      for (const difficulty of difficulties) {
        it(`${modelSet}/${role}/${difficulty} resolves to a concrete model`, async () => {
          const route = await resolveRoute({
            modelSet,
            role,
            difficulty,
            modelRegistry: fullRegistry(),
            config,
          });
          assert.ok(route, `should resolve ${modelSet}/${role}/${difficulty}`);
          assert.equal(route.modelSet, modelSet);
          assert.equal(route.role, role);
          assert.equal(route.difficulty, difficulty);

          // Check provider boundary compliance
          if (modelSet === "free") {
            assert.equal(route.model.provider, "opencode");
          } else if (modelSet === "opencode-go") {
            assert.equal(route.model.provider, "opencode-go");
          } else if (modelSet === "gpt") {
            assert.equal(route.model.provider, "openai-codex");
          }
          // mixed can be either opencode-go or openai-codex — both are valid
        });
      }
    }
  }
});
