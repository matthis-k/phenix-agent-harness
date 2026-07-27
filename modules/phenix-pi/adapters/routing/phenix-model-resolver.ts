import type {
  ConcreteModelRef,
  Difficulty,
  ModelCapability,
  ModelResolutionContext,
  ModelSelector,
  PhenixModelSetId,
  PiThinkingLevel,
  ResolvedModel,
  VirtualModelRef,
} from "../../domain/definition/model.ts";
import { virtualModel } from "../../domain/definition/model.ts";
import type { ModelInventory, ModelResolver } from "../../ports/model-resolver.ts";

interface CapabilityRoute {
  readonly capability: ModelCapability;
  readonly thinking: PiThinkingLevel;
}

type ModelRoutes = Readonly<Record<ModelCapability, ConcreteModelRef>>;

const FREE_MODELS = allCapabilities(model("opencode", "deepseek-v4-flash-free"));

const GO_MODELS: ModelRoutes = {
  fast: model("opencode-go", "mimo-v2.5"),
  general: model("opencode-go", "qwen3.7-plus"),
  reasoning: model("opencode-go", "glm-5.1"),
  "reasoning-max": model("opencode-go", "glm-5.2"),
  "code-fast": model("opencode-go", "kimi-k2.6"),
  code: model("opencode-go", "kimi-k2.7-code"),
  "code-max": model("opencode-go", "kimi-k2.7-code"),
  review: model("opencode-go", "qwen3.7-max"),
  "review-max": model("opencode-go", "glm-5.2"),
};

const GPT_MODELS: ModelRoutes = {
  fast: model("openai-codex", "gpt-5.6-luna"),
  general: model("openai-codex", "gpt-5.6-terra"),
  reasoning: model("openai-codex", "gpt-5.6-terra"),
  "reasoning-max": model("openai-codex", "gpt-5.6-sol"),
  "code-fast": model("openai-codex", "gpt-5.6-luna"),
  code: model("openai-codex", "gpt-5.6-terra"),
  "code-max": model("openai-codex", "gpt-5.6-sol"),
  review: model("openai-codex", "gpt-5.6-terra"),
  "review-max": model("openai-codex", "gpt-5.6-sol"),
};

const MODEL_SETS: Readonly<Record<PhenixModelSetId, ModelRoutes>> = {
  free: FREE_MODELS,
  "opencode-go": GO_MODELS,
  "chatgpt-plus": GPT_MODELS,
  mixed: {
    fast: GO_MODELS.fast,
    general: GO_MODELS.general,
    reasoning: GPT_MODELS.reasoning,
    "reasoning-max": GPT_MODELS["reasoning-max"],
    "code-fast": GO_MODELS["code-fast"],
    code: GO_MODELS.code,
    "code-max": GO_MODELS["code-max"],
    review: GPT_MODELS.review,
    "review-max": GPT_MODELS["review-max"],
  },
};

const ROUTES: Readonly<Record<string, Readonly<Record<Difficulty, CapabilityRoute>>>> = {
  base: difficulties("fast", "general", "reasoning", "reasoning-max", [
    "minimal",
    "low",
    "high",
    "xhigh",
  ]),
  scout: difficulties("fast", "fast", "general", "reasoning", ["minimal", "low", "medium", "high"]),
  planner: difficulties("general", "general", "reasoning", "reasoning-max", [
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
  architect: difficulties("general", "reasoning", "reasoning-max", "reasoning-max", [
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
  implementer: difficulties("code-fast", "code", "code", "code-max", [
    "low",
    "low",
    "medium",
    "high",
  ]),
  tester: difficulties("fast", "code-fast", "code", "code-max", [
    "minimal",
    "low",
    "medium",
    "high",
  ]),
  verifier: difficulties("general", "review", "review", "review-max", [
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
  critic: difficulties("general", "review", "review", "review-max", [
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
  finalizer: difficulties("fast", "general", "review", "review-max", [
    "minimal",
    "low",
    "medium",
    "high",
  ]),
  "qa-synthesizer": difficulties("general", "review", "review", "review-max", [
    "low",
    "medium",
    "high",
    "xhigh",
  ]),
};

export class PhenixModelResolver implements ModelResolver {
  private readonly inventory: ModelInventory;

  constructor(inventory: ModelInventory) {
    this.inventory = inventory;
  }

  async resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel> {
    const route = routeFor(context);
    const thinking = context.thinking === "route" ? route.thinking : context.thinking;

    if (selector.kind === "concrete") {
      this.requireAvailable(selector);
      return {
        requested: selector,
        concrete: selector,
        thinking,
        capability: route.capability,
      };
    }

    const modelSet = selector.kind === "virtual" ? selector.model : (context.modelSet ?? "mixed");
    const virtual: VirtualModelRef = virtualModel(modelSet);
    const concrete = MODEL_SETS[modelSet][route.capability];
    this.requireAvailable(concrete, modelSet, route.capability);

    return {
      requested: selector,
      virtual,
      concrete,
      thinking,
      capability: route.capability,
    };
  }

  private requireAvailable(
    concrete: ConcreteModelRef,
    modelSet?: PhenixModelSetId,
    capability?: ModelCapability,
  ): void {
    if (this.inventory.contains(concrete.provider, concrete.model)) return;
    const route = modelSet && capability ? ` for phenix/${modelSet} capability ${capability}` : "";
    throw new Error(
      `Configured model ${concrete.provider}/${concrete.model}${route} is unavailable`,
    );
  }
}

function model(provider: string, name: string): ConcreteModelRef {
  return { kind: "concrete", provider, model: name };
}

function allCapabilities(concrete: ConcreteModelRef): ModelRoutes {
  return {
    fast: concrete,
    general: concrete,
    reasoning: concrete,
    "reasoning-max": concrete,
    "code-fast": concrete,
    code: concrete,
    "code-max": concrete,
    review: concrete,
    "review-max": concrete,
  };
}

function routeFor(context: ModelResolutionContext): CapabilityRoute {
  const role = roleFromDefinition(context.definitionId);
  const difficulty = context.difficulty ?? defaultDifficulty(role);
  const routed = (ROUTES[role] ?? ROUTES.base)[difficulty];
  return {
    capability: context.capability ?? routed.capability,
    thinking: routed.thinking,
  };
}

function difficulties(
  d0: ModelCapability,
  d1: ModelCapability,
  d2: ModelCapability,
  d3: ModelCapability,
  thinking: readonly [PiThinkingLevel, PiThinkingLevel, PiThinkingLevel, PiThinkingLevel],
): Readonly<Record<Difficulty, CapabilityRoute>> {
  return {
    D0: { capability: d0, thinking: thinking[0] },
    D1: { capability: d1, thinking: thinking[1] },
    D2: { capability: d2, thinking: thinking[2] },
    D3: { capability: d3, thinking: thinking[3] },
  };
}

function roleFromDefinition(definition: string): string {
  return definition.split(".").at(-1) ?? "base";
}

function defaultDifficulty(role: string): Difficulty {
  if (["planner", "architect", "verifier", "critic", "qa-synthesizer"].includes(role)) {
    return "D2";
  }
  if (["scout", "tester"].includes(role)) return "D1";
  return "D1";
}
