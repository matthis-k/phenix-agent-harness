/**
 * phenix-routing — default routing data
 *
 * Bundled model pools, model sets, and agent route declarations.
 */

import { agentClientRef, capabilityRef } from "@matthis-k/phenix-kernel/refs.ts";
import type {
  AgentRouteDefinition,
  ModelPoolDefinition,
  ModelSetDefinition,
} from "@matthis-k/phenix-routing/definitions.ts";

// ── Model pools ────────────────────────────────────────────────────────────

export const defaultModelPools: readonly ModelPoolDefinition[] = [
  {
    id: "free.universal",
    candidates: [
      "opencode/deepseek-v4-flash-free",
      "opencode/mimo-v2.5-free",
      "opencode/north-mini-code-free",
    ],
  },

  // Keep DeepSeek V4 as a secondary candidate while OpenCode Go still rejects
  // some tool-enabled requests for those models at the gateway boundary.
  { id: "go.fast", candidates: ["opencode-go/mimo-v2.5", "opencode-go/deepseek-v4-flash"] },
  { id: "go.general", candidates: ["opencode-go/qwen3.7-plus", "opencode-go/deepseek-v4-pro"] },
  { id: "go.reasoning", candidates: ["opencode-go/glm-5.1", "opencode-go/qwen3.7-max"] },
  { id: "go.reasoning-max", candidates: ["opencode-go/glm-5.2", "opencode-go/glm-5.1"] },
  { id: "go.code-fast", candidates: ["opencode-go/kimi-k2.6", "opencode-go/deepseek-v4-flash"] },
  { id: "go.code", candidates: ["opencode-go/kimi-k2.7-code", "opencode-go/deepseek-v4-pro"] },
  { id: "go.code-max", candidates: ["opencode-go/kimi-k2.7-code", "opencode-go/glm-5.1"] },
  { id: "go.review", candidates: ["opencode-go/qwen3.7-max", "opencode-go/deepseek-v4-pro"] },
  { id: "go.review-max", candidates: ["opencode-go/glm-5.2", "opencode-go/qwen3.7-max"] },

  { id: "gpt.fast", candidates: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.4-mini"] },
  {
    id: "gpt.general",
    candidates: ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
  {
    id: "gpt.reasoning",
    candidates: ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
  {
    id: "gpt.pro",
    candidates: ["openai-codex/gpt-5.6", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
  { id: "gpt.code-fast", candidates: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.4-mini"] },
  {
    id: "gpt.code",
    candidates: ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
  {
    id: "gpt.code-max",
    candidates: ["openai-codex/gpt-5.6", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
  {
    id: "gpt.review",
    candidates: ["openai-codex/gpt-5.6-terra", "openai-codex/gpt-5.5", "openai-codex/gpt-5.4"],
  },
];

// ── Model sets ─────────────────────────────────────────────────────────────

export const defaultModelSets: readonly ModelSetDefinition[] = [
  {
    id: "free",
    capabilityPools: {
      fast: "free.universal",
      general: "free.universal",
      reasoning: "free.universal",
      "reasoning-max": "free.universal",
      "code-fast": "free.universal",
      code: "free.universal",
      "code-max": "free.universal",
      review: "free.universal",
      "review-max": "free.universal",
    },
    allowedProviders: ["opencode"],
    guards: {
      denySecrecy: ["private", "secret"],
      denyChangeKinds: ["security", "auth", "ci", "deployment"],
      denyTargetStates: ["main-bound"],
    },
  },
  {
    id: "opencode-go",
    capabilityPools: {
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
    allowedProviders: ["opencode-go"],
  },
  {
    id: "gpt",
    capabilityPools: {
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
    allowedProviders: ["openai", "openai-codex"],
  },
  {
    id: "mixed",
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
];

// ── Agent routes ────────────────────────────────────────────────────────────

export const defaultAgentRoutes: readonly AgentRouteDefinition[] = [
  {
    agentClient: agentClientRef("coordinator"),
    difficulties: {
      D0: { capability: capabilityRef("fast"), thinking: "minimal" },
      D1: { capability: capabilityRef("general"), thinking: "low" },
      D2: { capability: capabilityRef("reasoning"), thinking: "high" },
      D3: { capability: capabilityRef("reasoning-max"), thinking: "xhigh" },
    },
  },
  {
    agentClient: agentClientRef("base"),
    difficulties: {
      D0: { capability: capabilityRef("fast"), thinking: "minimal" },
      D1: { capability: capabilityRef("general"), thinking: "low" },
      D2: { capability: capabilityRef("reasoning"), thinking: "medium" },
      D3: { capability: capabilityRef("reasoning"), thinking: "high" },
    },
  },
  {
    agentClient: agentClientRef("scout"),
    difficulties: {
      D0: { capability: capabilityRef("fast"), thinking: "minimal" },
      D1: { capability: capabilityRef("fast"), thinking: "low" },
      D2: { capability: capabilityRef("general"), thinking: "medium" },
      D3: { capability: capabilityRef("reasoning"), thinking: "high" },
    },
  },
  {
    agentClient: agentClientRef("planner"),
    difficulties: {
      D0: { capability: capabilityRef("general"), thinking: "low" },
      D1: { capability: capabilityRef("general"), thinking: "medium" },
      D2: { capability: capabilityRef("reasoning"), thinking: "high" },
      D3: { capability: capabilityRef("reasoning-max"), thinking: "xhigh" },
    },
  },
  {
    agentClient: agentClientRef("architect"),
    difficulties: {
      D0: { capability: capabilityRef("general"), thinking: "low" },
      D1: { capability: capabilityRef("reasoning"), thinking: "medium" },
      D2: { capability: capabilityRef("reasoning-max"), thinking: "high" },
      D3: { capability: capabilityRef("reasoning-max"), thinking: "xhigh" },
    },
  },
  {
    agentClient: agentClientRef("implementer"),
    difficulties: {
      D0: { capability: capabilityRef("code-fast"), thinking: "low" },
      D1: { capability: capabilityRef("code"), thinking: "low" },
      D2: { capability: capabilityRef("code"), thinking: "medium" },
      D3: { capability: capabilityRef("code-max"), thinking: "high" },
    },
  },
  {
    agentClient: agentClientRef("tester"),
    difficulties: {
      D0: { capability: capabilityRef("fast"), thinking: "minimal" },
      D1: { capability: capabilityRef("code-fast"), thinking: "low" },
      D2: { capability: capabilityRef("code"), thinking: "medium" },
      D3: { capability: capabilityRef("code-max"), thinking: "high" },
    },
  },
  {
    agentClient: agentClientRef("critic"),
    difficulties: {
      D0: { capability: capabilityRef("general"), thinking: "low" },
      D1: { capability: capabilityRef("review"), thinking: "medium" },
      D2: { capability: capabilityRef("review"), thinking: "high" },
      D3: { capability: capabilityRef("review-max"), thinking: "xhigh" },
    },
  },
  {
    agentClient: agentClientRef("finalizer"),
    difficulties: {
      D0: { capability: capabilityRef("fast"), thinking: "minimal" },
      D1: { capability: capabilityRef("general"), thinking: "low" },
      D2: { capability: capabilityRef("review"), thinking: "medium" },
      D3: { capability: capabilityRef("review-max"), thinking: "high" },
    },
  },
];
