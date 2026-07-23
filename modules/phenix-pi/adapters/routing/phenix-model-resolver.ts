import type {
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

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
}

interface CapabilityRoute {
  readonly capability: ModelCapability;
  readonly thinking: PiThinkingLevel;
}

interface ModelSetDefinition {
  readonly capabilityPools: Readonly<Record<ModelCapability, string>>;
  readonly allowedProviders: readonly string[];
}

export interface RoutingPolicy {
  readonly revision: string;
  route(context: ModelResolutionContext): CapabilityRoute;
  candidates(modelSet: PhenixModelSetId, capability: ModelCapability): readonly ModelCandidate[];
  allows(modelSet: PhenixModelSetId, candidate: ModelCandidate): boolean;
}

const POOLS: Readonly<Record<string, readonly ModelCandidate[]>> = {
  "free.universal": [
    candidate("opencode", "deepseek-v4-flash-free"),
    candidate("opencode", "mimo-v2.5-free"),
    candidate("opencode", "north-mini-code-free"),
  ],
  "go.fast": [
    candidate("opencode-go", "mimo-v2.5"),
    candidate("opencode-go", "deepseek-v4-flash"),
  ],
  "go.general": [
    candidate("opencode-go", "qwen3.7-plus"),
    candidate("opencode-go", "deepseek-v4-pro"),
  ],
  "go.reasoning": [
    candidate("opencode-go", "glm-5.1"),
    candidate("opencode-go", "qwen3.7-max"),
  ],
  "go.reasoning-max": [
    candidate("opencode-go", "glm-5.2"),
    candidate("opencode-go", "glm-5.1"),
  ],
  "go.code-fast": [
    candidate("opencode-go", "kimi-k2.6"),
    candidate("opencode-go", "deepseek-v4-flash"),
  ],
  "go.code": [
    candidate("opencode-go", "kimi-k2.7-code"),
    candidate("opencode-go", "deepseek-v4-pro"),
  ],
  "go.code-max": [
    candidate("opencode-go", "kimi-k2.7-code"),
    candidate("opencode-go", "glm-5.1"),
  ],
  "go.review": [
    candidate("opencode-go", "qwen3.7-max"),
    candidate("opencode-go", "deepseek-v4-pro"),
  ],
  "go.review-max": [
    candidate("opencode-go", "glm-5.2"),
    candidate("opencode-go", "qwen3.7-max"),
  ],
  "gpt.fast": [
    candidate("openai-codex", "gpt-5.6-luna"),
    candidate("openai-codex", "gpt-5.4-mini"),
  ],
  "gpt.general": [
    candidate("openai-codex", "gpt-5.6-terra"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
  "gpt.reasoning": [
    candidate("openai-codex", "gpt-5.6-terra"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
  "gpt.pro": [
    candidate("openai-codex", "gpt-5.6"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
  "gpt.code-fast": [
    candidate("openai-codex", "gpt-5.6-luna"),
    candidate("openai-codex", "gpt-5.4-mini"),
  ],
  "gpt.code": [
    candidate("openai-codex", "gpt-5.6-terra"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
  "gpt.code-max": [
    candidate("openai-codex", "gpt-5.6"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
  "gpt.review": [
    candidate("openai-codex", "gpt-5.6-terra"),
    candidate("openai-codex", "gpt-5.5"),
    candidate("openai-codex", "gpt-5.4"),
  ],
};

const FREE_POOLS = allCapabilities("free.universal");
const GO_POOLS: Readonly<Record<ModelCapability, string>> = {
  fast: "go.fast",
  general: "go.general",
  reasoning: "go.reasoning",
  "reasoning-max": "go.reasoning-max",
  "code-fast": "go.code-fast",
  code: "go.code",
  "code-max": "go.code-max",
  review: "go.review",
  "review-max": "go.review-max",
};
const GPT_POOLS: Readonly<Record<ModelCapability, string>> = {
  fast: "gpt.fast",
  general: "gpt.general",
  reasoning: "gpt.reasoning",
  "reasoning-max": "gpt.pro",
  "code-fast": "gpt.code-fast",
  code: "gpt.code",
  "code-max": "gpt.code-max",
  review: "gpt.review",
  "review-max": "gpt.pro",
};

export const MODEL_SETS: Readonly<Record<PhenixModelSetId, ModelSetDefinition>> = {
  free: { capabilityPools: FREE_POOLS, allowedProviders: ["opencode"] },
  "opencode-go": { capabilityPools: GO_POOLS, allowedProviders: ["opencode-go"] },
  "chatgpt-plus": {
    capabilityPools: GPT_POOLS,
    allowedProviders: ["openai", "openai-codex"],
  },
  mixed: {
    capabilityPools: {
      fast: "go.fast",
      general: "go.general",
      reasoning: "gpt.reasoning",
      "reasoning-max": "gpt.pro",
      "code-fast": "go.code-fast",
      code: "go.code",
      "code-max": "go.code-max",
      review: "gpt.review",
      "review-max": "gpt.pro",
    },
    allowedProviders: ["opencode-go", "openai", "openai-codex"],
  },
};

const ROUTES: Readonly<Record<string, Readonly<Record<Difficulty, CapabilityRoute>>>> = {
  base: difficulties("fast", "general", "reasoning", "reasoning-max", [
    "minimal",
    "low",
    "high",
    "xhigh",
  ]),
  scout: difficulties("fast", "fast", "general", "reasoning", [
    "minimal",
    "low",
    "medium",
    "high",
  ]),
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

export const defaultRoutingPolicy: RoutingPolicy = {
  revision: "phenix-routing-v2",
  route(context) {
    const role = roleFromDefinition(context.definitionId);
    const difficulty = context.difficulty ?? defaultDifficulty(role);
    return (ROUTES[role] ?? ROUTES.base)[difficulty];
  },
  candidates(modelSet, capability) {
    const pool = MODEL_SETS[modelSet].capabilityPools[capability];
    return POOLS[pool] ?? [];
  },
  allows(modelSet, candidateValue) {
    return MODEL_SETS[modelSet].allowedProviders.includes(candidateValue.provider);
  },
};

/** Kept as a compatibility name for callers from the temporary rewrite. */
export const deterministicMixedPolicy = defaultRoutingPolicy;

export class PhenixModelResolver implements ModelResolver {
  private readonly inventory: ModelInventory;
  private readonly policy: RoutingPolicy;

  constructor(inventory: ModelInventory, policy: RoutingPolicy = defaultRoutingPolicy) {
    this.inventory = inventory;
    this.policy = policy;
  }

  async resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel> {
    const candidates = await this.resolveCandidates(selector, context);
    const selected = candidates[0];
    if (!selected) throw new Error(`No eligible model candidate was resolved`);
    return selected;
  }

  async resolveCandidates(
    selector: ModelSelector,
    context: ModelResolutionContext,
  ): Promise<readonly ResolvedModel[]> {
    const route = this.policy.route(context);
    const thinking = context.thinking === "route" ? route.thinking : context.thinking;

    if (selector.kind === "concrete") {
      if (!this.inventory.contains(selector.provider, selector.model)) {
        throw new Error(`Concrete model ${selector.provider}/${selector.model} is unavailable`);
      }
      return [
        {
          requested: selector,
          concrete: selector,
          thinking,
          capability: route.capability,
          policyRevision: this.policy.revision,
        },
      ];
    }

    const modelSet = selector.kind === "virtual" ? selector.model : (context.modelSet ?? "mixed");
    const virtual: VirtualModelRef = virtualModel(modelSet);
    const pool = MODEL_SETS[modelSet].capabilityPools[route.capability];
    const available = new Set(
      this.inventory.available().map((item) => `${item.provider}/${item.model}`),
    );
    const eligible = this.policy
      .candidates(modelSet, route.capability)
      .filter((item) => this.policy.allows(modelSet, item))
      .filter((item) => available.has(`${item.provider}/${item.model}`));

    if (eligible.length === 0) {
      const configured = this.policy
        .candidates(modelSet, route.capability)
        .map((item) => `${item.provider}/${item.model}`)
        .join(", ");
      throw new Error(
        `No authenticated model is available for phenix/${modelSet} capability ${route.capability}. ` +
          `Configured candidates: ${configured || "none"}`,
      );
    }

    return eligible.map((item) => ({
      requested: selector,
      virtual,
      concrete: { kind: "concrete", provider: item.provider, model: item.model },
      thinking,
      capability: route.capability,
      pool,
      policyRevision: this.policy.revision,
    }));
  }
}

function candidate(provider: string, model: string): ModelCandidate {
  return { provider, model };
}

function allCapabilities(pool: string): Readonly<Record<ModelCapability, string>> {
  return {
    fast: pool,
    general: pool,
    reasoning: pool,
    "reasoning-max": pool,
    "code-fast": pool,
    code: pool,
    "code-max": pool,
    review: pool,
    "review-max": pool,
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
