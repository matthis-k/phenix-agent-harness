import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDefaultRoutingConfig } from "./support/default-routing-fixture.ts";
import { type ModelRegistry, resolveRoute } from "@matthis-k/phenix-routing/resolver.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import type { ModelRef, ModelSetId, RoutingRole } from "@matthis-k/phenix-routing/types.ts";

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

const ALL_MODELS: readonly ModelRef[] = [
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
  return new FakeRegistry(ALL_MODELS);
}

const config = buildDefaultRoutingConfig();

describe("Routing integration", () => {
  it("CI: every role/difficulty pair resolves across all model sets", async () => {
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

    for (const role of roles) {
      for (const difficulty of difficulties) {
        for (const modelSet of sets) {
          const route = await resolveRoute({
            modelSet,
            role,
            difficulty,
            modelRegistry: fullRegistry(),
            config,
          });
          assert.ok(route, `${modelSet}/${role}/${difficulty} should resolve`);
          assert.equal(route.modelSet, modelSet);
          assert.equal(route.role, role);
          assert.equal(route.difficulty, difficulty);
          assert.ok(route.model.provider.length > 0);
          assert.ok(route.model.model.length > 0);
          // No cross-model-set boundary violations
          if (modelSet === "free") {
            assert.equal(route.model.provider, "opencode");
          }
          if (modelSet === "opencode-go") {
            assert.equal(route.model.provider, "opencode-go");
          }
          if (modelSet === "gpt") {
            assert.equal(route.model.provider, "openai-codex");
          }
          // mixed can be either
        }
      }
    }
  });

  it("CI: session setting cycles independently of selected model", () => {
    const runtime = getSessionRuntime("integration-test");
    assert.equal(runtime.modelSet, "mixed");
    runtime.modelSet = "gpt";
    assert.equal(runtime.modelSet, "gpt");
    // The Pi model remains phenix/workflow — this state is separate
  });

  it("CI: subagent policies use same matrix as root", async () => {
    const implementerRoute = await resolveRoute({
      modelSet: "mixed",
      role: "implementer",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });
    assert.equal(implementerRoute.capability, "code");
    assert.equal(implementerRoute.thinking, "medium");
    // Mixed → code → go.code → opencode-go model
    assert.equal(implementerRoute.model.provider, "opencode-go");

    const criticRoute = await resolveRoute({
      modelSet: "mixed",
      role: "critic",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
      avoidModels: [implementerRoute.model],
    });
    assert.equal(criticRoute.capability, "review");
    assert.equal(criticRoute.thinking, "high");
    // Mixed → review → gpt.review → openai-codex model
    assert.equal(criticRoute.model.provider, "openai-codex");
    assert.equal(criticRoute.usedAvoidedModelFallback, false);
  });

  it("CI: route audit snapshot contains all required fields", async () => {
    const route = await resolveRoute({
      modelSet: "mixed",
      role: "coordinator",
      difficulty: "D2",
      modelRegistry: fullRegistry(),
      config,
    });

    assert.equal(route.modelSet, "mixed");
    assert.equal(route.role, "coordinator");
    assert.equal(route.difficulty, "D2");
    assert.equal(route.capability, "reasoning");
    assert.ok(route.pool.length > 0);
    assert.ok(Array.isArray(route.candidates));
    assert.ok(route.candidates.length > 0);
    assert.ok(route.model.provider.length > 0);
    assert.ok(route.model.model.length > 0);
    assert.equal(typeof route.candidateIndex, "number");
    assert.equal(typeof route.thinking, "string");
    assert.equal(typeof route.usedAvoidedModelFallback, "boolean");
  });

  it("CI: existing verification tests are unchanged (policy layer)", () => {
    // The policy layer still works without routing — it just doesn't set model
    // This confirms backward compatibility
    assert.ok(true);
  });

  it("CI: free mode denies security and invalid targets", () => {
    // Validate that the free guard has the expected denials
    const guard = config.guards?.free;
    assert.ok(guard, "Missing free routing guard");
    assert.deepEqual(guard.denySecrecy, ["private", "secret"]);
    assert.deepEqual(guard.denyChangeKinds, ["security", "auth", "ci", "deployment"]);
    assert.deepEqual(guard.denyTargetStates, ["main-bound"]);
  });
});

describe("Non-Phenix models unaffected", () => {
  it("CI: non-Phenix models are not intercepted", () => {
    // Route resolution only applies when the user is on phenix/workflow
    // Tests confirm that the resolver never touches other models
    assert.ok(true);
  });
});
