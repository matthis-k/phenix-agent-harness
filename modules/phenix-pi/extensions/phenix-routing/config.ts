import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeObjects, readJson } from "../phenix-shared.ts";

import {
  type ModelSetId,
  type RoutingConfig,
  MODEL_SET_IDS,
  parseModelRef,
} from "./types.ts";

const ALL_CAPABILITIES = [
  "fast",
  "general",
  "reasoning",
  "reasoning-max",
  "code-fast",
  "code",
  "code-max",
  "review",
  "review-max",
] as const;

function getAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ??
    path.join(os.homedir(), ".pi", "agent")
  );
}

export interface ConfigDiagnostic {
  readonly message: string;
  readonly severity: "error" | "warning";
}

/**
 * Validate a complete merged routing configuration.
 * Returns an array of error strings (empty = valid).
 */
export function validateConfig(
  config: RoutingConfig,
  bundled: RoutingConfig,
): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  // Validate defaultModelSet
  if (!MODEL_SET_IDS.includes(config.defaultModelSet as ModelSetId)) {
    diagnostics.push({
      message: `defaultModelSet "${config.defaultModelSet}" is not a valid model set; expected one of ${MODEL_SET_IDS.join(", ")}`,
      severity: "error",
    });
  }

  // Validate modelSetOrder
  if (config.modelSetOrder.length === 0) {
    diagnostics.push({
      message: "modelSetOrder is empty",
      severity: "error",
    });
  }
  const seen = new Set<string>();
  for (const setId of config.modelSetOrder) {
    if (!MODEL_SET_IDS.includes(setId as ModelSetId)) {
      diagnostics.push({
        message: `modelSetOrder contains unknown model set "${setId}"`,
        severity: "error",
      });
    }
    if (seen.has(setId)) {
      diagnostics.push({
        message: `modelSetOrder contains duplicate "${setId}"`,
        severity: "error",
      });
    }
    seen.add(setId);
  }

  // Validate pools
  for (const [poolName, candidates] of Object.entries(config.pools)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      diagnostics.push({
        message: `pool "${poolName}" is empty or invalid`,
        severity: "error",
      });
      continue;
    }
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (typeof candidate !== "string") {
        diagnostics.push({
          message: `pool "${poolName}" candidate at index ${i} is not a string`,
          severity: "error",
        });
        continue;
      }
      try {
        parseModelRef(candidate);
      } catch {
        diagnostics.push({
          message: `pool "${poolName}" candidate "${candidate}" is malformed: expected "provider/model"`,
          severity: "error",
        });
      }
    }
  }

  // Validate modelSets
  for (const setId of MODEL_SET_IDS) {
    const ms = config.modelSets[setId];
    if (!ms) {
      diagnostics.push({
        message: `modelSet "${setId}" is missing from modelSets`,
        severity: "error",
      });
      continue;
    }
    for (const cap of ALL_CAPABILITIES) {
      const poolName = ms[cap as keyof typeof ms];
      if (!poolName) {
        diagnostics.push({
          message: `modelSet "${setId}" is missing capability "${cap}"`,
          severity: "error",
        });
        continue;
      }
      if (typeof poolName !== "string") {
        diagnostics.push({
          message: `modelSet "${setId}" capability "${cap}" is not a string`,
          severity: "error",
        });
        continue;
      }
      if (!config.pools[poolName]) {
        diagnostics.push({
          message: `modelSet "${setId}" capability "${cap}" references unknown pool "${poolName}"`,
          severity: "error",
        });
      }
    }
  }

  // Validate provider boundaries in guards
  if (config.guards) {
    for (const [setId, guard] of Object.entries(config.guards)) {
      if (!MODEL_SET_IDS.includes(setId as ModelSetId)) {
        diagnostics.push({
          message: `guards reference unknown model set "${setId}"`,
          severity: "error",
        });
        continue;
      }
      if (guard.allowedProviders?.length === 0) {
        diagnostics.push({
          message: `modelSet "${setId}" guard has empty allowedProviders`,
          severity: "error",
        });
      }
    }
  }

  return diagnostics;
}

function buildDefaultPools(): Record<string, readonly string[]> {
  return {
    "free.universal": ["opencode/deepseek-v4-flash-free"],

    "go.fast":         ["opencode-go/deepseek-v4-flash", "opencode-go/mimo-v2.5"],
    "go.general":      ["opencode-go/deepseek-v4-pro", "opencode-go/qwen3.7-plus"],
    "go.reasoning":    ["opencode-go/glm-5.1", "opencode-go/qwen3.7-max"],
    "go.reasoning-max": ["opencode-go/glm-5.2", "opencode-go/glm-5.1"],
    "go.code-fast":    ["opencode-go/deepseek-v4-flash", "opencode-go/kimi-k2.6"],
    "go.code":         ["opencode-go/kimi-k2.7-code", "opencode-go/deepseek-v4-pro"],
    "go.code-max":     ["opencode-go/kimi-k2.7-code", "opencode-go/glm-5.1"],
    "go.review":       ["opencode-go/qwen3.7-max", "opencode-go/deepseek-v4-pro"],
    "go.review-max":   ["opencode-go/glm-5.2", "opencode-go/qwen3.7-max"],

    "gpt.fast":        ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini"],
    "gpt.general":     ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    "gpt.reasoning":   ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    "gpt.pro":         ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    "gpt.code-fast":   ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4-mini"],
    "gpt.code":        ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    "gpt.code-max":    ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
    "gpt.review":      ["openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  };
}

function buildDefaultModelSets(): Record<ModelSetId, Record<string, string>> {
  const allCaps: Record<string, string> = {};
  for (const cap of ALL_CAPABILITIES) allCaps[cap] = "";

  return {
    free: {
      fast: "free.universal",
      general: "free.universal",
      reasoning: "free.universal",
      "reasoning-max": "free.universal",
      "code-fast": "free.universal",
      code: "free.universal",
      "code-max": "free.universal",
      review: "free.universal",
      "review-max": "free.universal",
    } as Record<string, string>,
    "opencode-go": {
      fast: "go.fast",
      general: "go.general",
      reasoning: "go.reasoning",
      "reasoning-max": "go.reasoning-max",
      "code-fast": "go.code-fast",
      code: "go.code",
      "code-max": "go.code-max",
      review: "go.review",
      "review-max": "go.review-max",
    },
    gpt: {
      fast: "gpt.fast",
      general: "gpt.general",
      reasoning: "gpt.reasoning",
      "reasoning-max": "gpt.pro",
      "code-fast": "gpt.code-fast",
      code: "gpt.code",
      "code-max": "gpt.code-max",
      review: "gpt.review",
      "review-max": "gpt.pro",
    },
    mixed: {
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
  };
}

function buildDefaultGuards(): RoutingConfig["guards"] {
  return {
    free: {
      allowedProviders: ["opencode"],
      denySecrecy: ["private", "secret"],
      denyChangeKinds: ["security", "auth", "ci", "deployment"],
      denyTargetStates: ["main-bound"],
    },
    "opencode-go": {
      allowedProviders: ["opencode-go"],
    },
    gpt: {
      allowedProviders: ["openai", "openai-codex"],
    },
    mixed: {
      allowedProviders: ["opencode-go", "openai", "openai-codex"],
    },
  };
}

export function buildBundledConfig(): RoutingConfig {
  return {
    defaultModelSet: "mixed",
    modelSetOrder: ["free", "opencode-go", "gpt", "mixed"],
    pools: buildDefaultPools(),
    modelSets: buildDefaultModelSets(),
    guards: buildDefaultGuards(),
  };
}

/**
 * Load routing configuration.
 * Tries bundled config first, then deep-merges user override from
 * $PI_CODING_AGENT_DIR/phenix-routing.json.
 * Validates the merged result; falls back to bundled on errors.
 */
export function loadRoutingConfig(): RoutingConfig {
  const bundled = buildBundledConfig() as unknown as Record<string, unknown>;

  // Try loading from config file path first
  const bundledPath = fileURLToPath(
    new URL("../../config/routing.json", import.meta.url),
  );
  const fileBundled = readJson(bundledPath);
  const effectiveBundled = fileBundled
    ? (mergeObjects(bundled, fileBundled) as RoutingConfig)
    : (bundled as RoutingConfig);

  // User override
  const userPath = path.join(getAgentDir(), "phenix-routing.json");
  const userConfig = readJson(userPath);

  if (!userConfig) return effectiveBundled;

  const merged = mergeObjects(
    effectiveBundled as unknown as Record<string, unknown>,
    userConfig,
  ) as RoutingConfig;

  const diagnostics = validateConfig(merged, effectiveBundled);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    // Console warn and fall back to bundled
    console.error("[phenix-routing] Invalid user routing configuration, falling back to bundled:");
    for (const error of errors) {
      console.error(`  ERROR: ${error.message}`);
    }
    return effectiveBundled;
  }

  return merged;
}

export function providerBoundaryForSet(modelSetId: ModelSetId, config: RoutingConfig): readonly string[] {
  return config.guards?.[modelSetId]?.allowedProviders ?? [];
}

export function isProviderAllowed(provider: string, allowedProviders: readonly string[]): boolean {
  return allowedProviders.includes(provider);
}
