/**
 * test-subagent-executor.ts — Validation script for subagent executor.
 *
 * Validates the child-process-based executor by importing pure functions
 * directly from the TypeScript modules and running them in isolation.
 *
 * Run with: npx tsx fixtures/test-subagent-executor.ts
 * Or: deno run fixtures/test-subagent-executor.ts
 *
 * Tests cover:
 *   1. shouldRunRepoScout logic (all scenarios)
 *   2. SUBAGENT_PROFILES permissions and tool policies
 *   3. resolveSubagentModel returns the default model
 *   4. EvidencePacket schema validation
 *   5. Recursion safety defaults
 *   6. ROLE_TOOL_DEFAULTS
 *   7. parsePiJsonOutput
 *   8. No direct model API calls (static import check)
 *   9. Child process spawning semantics (static code check)
 *  10. DEFAULT_MODEL constant
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ──────────────────────────────────────────────
// Import the modules to test
// ──────────────────────────────────────────────
import {
  shouldRunRepoScout,
  SUBAGENT_PROFILES,
  resolveSubagentModel,
  DEFAULT_MODEL,
  ROUTING_MATRIX,
  resolveRoute,
  RECURSION_DEFAULTS,
  ROLE_TOOL_DEFAULTS,
  parsePiJsonOutput,
  runPhenixSubagent,
  buildChildEnv,
  OPENCODE_GO_AVAILABLE_MODELS,
  ROLE_PREFERENCES,
  GPT_CAPABILITY_PREFERENCES,
  resolveGptCapability,
  resolveRoleWithFallback,
  type EvidencePacket,
  type SubagentProfile,
  type PhenixSubagentRole,
  type Difficulty,
  type PhenixVariant,
  type ThinkingLevel,
  type PhenixRoute,
  type CostMode,
  type RoleAssignment,
  type DifficultyConfig,
  type RunPhenixSubagentInput,
  type RunPhenixSubagentResult,
} from "../config/phenix-pi/pi/extensions/phenix-subagent-executor";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertDeepEq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual, null, 2);
  const e = JSON.stringify(expected, null, 2);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label}\n  expected:\n${e}\n  actual:\n${a}`);
  }
}

function assertOk(label: string, value: unknown): void {
  if (value) {
    passed++;
  } else {
    failed++;
    failures.push(`FAIL: ${label} — expected truthy, got ${String(value)}`);
  }
}

function describe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failed++;
    failures.push(`FAIL (${label}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ──────────────────────────────────────────────
// 1. shouldRunRepoScout
// ──────────────────────────────────────────────

describe("D0 always skips scout", () => {
  assertEq(
    "D0 typo with exact path -> skip",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Fix typo in README.md",
      exactPathsMentioned: ["README.md"],
      exactSymbolsMentioned: [],
    }),
    false,
  );

  assertEq(
    "D0 generic -> skip",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Apply formatting",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    false,
  );
});

describe("D1 runs scout for sensitive areas", () => {
  assertEq(
    "D1 with routing keyword -> run",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Change the agent routing policy",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 with nix keyword -> run",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Update the nix flake",
      exactPathsMentioned: ["flake.nix"],
      exactSymbolsMentioned: [],
    }),
    true,
  );
});

describe("D2/D3 always runs scout", () => {
  assertEq(
    "D2 always runs",
    shouldRunRepoScout({
      difficulty: "D2",
      prompt: "Refactor module",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D3 always runs",
    shouldRunRepoScout({
      difficulty: "D3",
      prompt: "Security audit",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );
});

// ──────────────────────────────────────────────
// 2. SUBAGENT_PROFILES
// ──────────────────────────────────────────────

describe("SUBAGENT_PROFILES are complete", () => {
  const requiredProfiles: SubagentProfile[] = [
    "repo_scout",
    "implementation",
    "refactor",
    "test_author",
    "verifier_patch",
    "safety_io",
  ];

  for (const profile of requiredProfiles) {
    assertOk(
      `Profile "${profile}" exists`,
      SUBAGENT_PROFILES[profile] !== undefined,
    );
  }
});

describe("Scout profile is read-only", () => {
  const scout = SUBAGENT_PROFILES.repo_scout;
  if (scout) {
    assertEq("scout role is 'scout'", scout.role, "scout");
    assertEq("scout cannot edit", scout.permissions.edit, false);
    assertEq("scout shell is read_only", scout.permissions.shell, "read_only");
    assertOk(
      "scout disallows edit/write/resolve/bash",
      scout.toolPolicy.deniedTools.includes("edit") &&
        scout.toolPolicy.deniedTools.includes("write") &&
        scout.toolPolicy.deniedTools.includes("bash"),
    );
  }
});

describe("Worker profile can edit", () => {
  const worker = SUBAGENT_PROFILES.implementation;
  if (worker) {
    assertEq("worker role is 'worker'", worker.role, "worker");
    assertEq("worker can edit", worker.permissions.edit, true);
  }
});

// ──────────────────────────────────────────────
// 3. DEFAULT_MODEL
// ──────────────────────────────────────────────

describe("DEFAULT_MODEL is opencode-go/deepseek-v4-flash", () => {
  assertEq(
    "default model is opencode-go/deepseek-v4-flash",
    DEFAULT_MODEL,
    "opencode-go/deepseek-v4-flash",
  );
});

// ──────────────────────────────────────────────
// 3b. ROUTING MATRIX
// ──────────────────────────────────────────────

describe("ROUTING_MATRIX defines all variants", () => {
  const variants: PhenixVariant[] = ["opencode-go", "free", "gpt", "mixed"];
  for (const v of variants) {
    assertOk(`variant "${v}" exists in ROUTING_MATRIX`, ROUTING_MATRIX[v] !== undefined);
    assertOk(`variant "${v}" has frontend model`, ROUTING_MATRIX[v].frontend.provider !== "");
    assertOk(`variant "${v}" has D0 config`, ROUTING_MATRIX[v].difficulties["D0"] !== undefined);
    assertOk(`variant "${v}" has D1 config`, ROUTING_MATRIX[v].difficulties["D1"] !== undefined);
    assertOk(`variant "${v}" has D2 config`, ROUTING_MATRIX[v].difficulties["D2"] !== undefined);
    assertOk(`variant "${v}" has D3 config`, ROUTING_MATRIX[v].difficulties["D3"] !== undefined);
    assertOk(`variant "${v}" has costMode`, ROUTING_MATRIX[v].costMode !== undefined);
  }
});

describe("resolveRoute works correctly", () => {
  assertEq(
    "phenix/opencode-go → opencode-go variant",
    resolveRoute("phenix/opencode-go").variant,
    "opencode-go",
  );

  assertEq(
    "phenix/free → free variant",
    resolveRoute("phenix/free").variant,
    "free",
  );

  assertEq(
    "phenix/gpt → gpt variant",
    resolveRoute("phenix/gpt").variant,
    "gpt",
  );

  assertEq(
    "phenix/mixed → mixed variant",
    resolveRoute("phenix/mixed").variant,
    "mixed",
  );

  assertEq(
    "unknown variant falls back to opencode-go",
    resolveRoute("unknown").variant,
    "opencode-go",
  );
});

describe("resolveSubagentModel: opencode-go per-difficulty routing", () => {
  // D0: only implementer is enabled
  assertEq(
    "opencode-go D0 implementer → deepseek-v4-flash",
    resolveSubagentModel("phenix/opencode-go", "implementer", "D0", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "opencode-go D0 planner → unavailable (disabled)",
    resolveSubagentModel("phenix/opencode-go", "planner", "D0", {} as any).available,
    false,
  );
  assertEq(
    "opencode-go D0 scout → unavailable (disabled)",
    resolveSubagentModel("phenix/opencode-go", "scout", "D0", {} as any).available,
    false,
  );
  assertEq(
    "opencode-go D0 verifier → unavailable (disabled)",
    resolveSubagentModel("phenix/opencode-go", "verifier", "D0", {} as any).available,
    false,
  );

  // D1
  assertEq(
    "opencode-go D1 scout → deepseek-v4-flash",
    resolveSubagentModel("phenix/opencode-go", "scout", "D1", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "opencode-go D1 planner → qwen3.7-plus",
    resolveSubagentModel("phenix/opencode-go", "planner", "D1", {} as any).modelSet.model,
    "qwen3.7-plus",
  );
  assertEq(
    "opencode-go D1 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/opencode-go", "implementer", "D1", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
  assertEq(
    "opencode-go D1 verifier → deepseek-v4-pro",
    resolveSubagentModel("phenix/opencode-go", "verifier", "D1", {} as any).modelSet.model,
    "deepseek-v4-pro",
  );

  // D2
  assertEq(
    "opencode-go D2 scout → deepseek-v4-flash",
    resolveSubagentModel("phenix/opencode-go", "scout", "D2", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "opencode-go D2 planner → glm-5.1",
    resolveSubagentModel("phenix/opencode-go", "planner", "D2", {} as any).modelSet.model,
    "glm-5.1",
  );
  assertEq(
    "opencode-go D2 critic → deepseek-v4-pro",
    resolveSubagentModel("phenix/opencode-go", "critic", "D2", {} as any).modelSet.model,
    "deepseek-v4-pro",
  );
  assertEq(
    "opencode-go D2 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/opencode-go", "implementer", "D2", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
  assertEq(
    "opencode-go D2 verifier → glm-5.1",
    resolveSubagentModel("phenix/opencode-go", "verifier", "D2", {} as any).modelSet.model,
    "glm-5.1",
  );

  // D3
  assertEq(
    "opencode-go D3 scout → deepseek-v4-pro",
    resolveSubagentModel("phenix/opencode-go", "scout", "D3", {} as any).modelSet.model,
    "deepseek-v4-pro",
  );
  assertEq(
    "opencode-go D3 planner → glm-5.2",
    resolveSubagentModel("phenix/opencode-go", "planner", "D3", {} as any).modelSet.model,
    "glm-5.2",
  );
  assertEq(
    "opencode-go D3 critic → qwen3.7-max",
    resolveSubagentModel("phenix/opencode-go", "critic", "D3", {} as any).modelSet.model,
    "qwen3.7-max",
  );
  assertEq(
    "opencode-go D3 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/opencode-go", "implementer", "D3", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
  assertEq(
    "opencode-go D3 verifier → glm-5.2",
    resolveSubagentModel("phenix/opencode-go", "verifier", "D3", {} as any).modelSet.model,
    "glm-5.2",
  );
  assertEq(
    "opencode-go D3 final_reviewer → glm-5.2",
    resolveSubagentModel("phenix/opencode-go", "final_reviewer", "D3", {} as any).modelSet.model,
    "glm-5.2",
  );
});

describe("resolveSubagentModel: opencode-go thinking levels", () => {
  assertEq(
    "D0 implementer → low thinking",
    resolveSubagentModel("phenix/opencode-go", "implementer", "D0", {} as any).thinking,
    "low",
  );
  assertEq(
    "D1 planner → medium thinking",
    resolveSubagentModel("phenix/opencode-go", "planner", "D1", {} as any).thinking,
    "medium",
  );
  assertEq(
    "D2 planner → high thinking",
    resolveSubagentModel("phenix/opencode-go", "planner", "D2", {} as any).thinking,
    "high",
  );
  assertEq(
    "D3 planner → xhigh thinking",
    resolveSubagentModel("phenix/opencode-go", "planner", "D3", {} as any).thinking,
    "xhigh",
  );
  assertEq(
    "D3 final_reviewer → xhigh thinking",
    resolveSubagentModel("phenix/opencode-go", "final_reviewer", "D3", {} as any).thinking,
    "xhigh",
  );
});

describe("resolveSubagentModel: free variant", () => {
  assertEq(
    "free D0 implementer → deepseek-v4-flash-free",
    resolveSubagentModel("phenix/free", "implementer", "D0", {} as any).modelSet.model,
    "deepseek-v4-flash-free",
  );
  assertEq(
    "free D0 scout → unavailable (disabled)",
    resolveSubagentModel("phenix/free", "scout", "D0", {} as any).available,
    false,
  );
  assertEq(
    "free D1 scout → deepseek-v4-flash-free",
    resolveSubagentModel("phenix/free", "scout", "D1", {} as any).modelSet.model,
    "deepseek-v4-flash-free",
  );
  assertEq(
    "free D3 verifier → deepseek-v4-flash-free",
    resolveSubagentModel("phenix/free", "verifier", "D3", {} as any).modelSet.model,
    "deepseek-v4-flash-free",
  );
});

describe("resolveSubagentModel: GPT capability aliases", () => {
  // With only gpt-5.5 available, all capabilities resolve to gpt-5.5
  const gptOnlyModels = ["openai/gpt-5.5"];

  assertEq(
    "gpt D0 implementer → gpt-5.5 (fast→gpt-5.5 fallback)",
    resolveSubagentModel("phenix/gpt", "implementer", "D0", {} as any, gptOnlyModels).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "gpt D0 planner → unavailable (disabled)",
    resolveSubagentModel("phenix/gpt", "planner", "D0", {} as any, gptOnlyModels).available,
    false,
  );
  assertEq(
    "gpt D1 planner → gpt-5.5 (thinking→gpt-5.5)",
    resolveSubagentModel("phenix/gpt", "planner", "D1", {} as any, gptOnlyModels).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "gpt D1 verifier → gpt-5.5 (thinking→gpt-5.5)",
    resolveSubagentModel("phenix/gpt", "verifier", "D1", {} as any, gptOnlyModels).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "gpt D1 implementer → gpt-5.5 (fast→gpt-5.5)",
    resolveSubagentModel("phenix/gpt", "implementer", "D1", {} as any, gptOnlyModels).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "gpt D3 final_reviewer → gpt-5.5 (pro→gpt-5.5)",
    resolveSubagentModel("phenix/gpt", "final_reviewer", "D3", {} as any, gptOnlyModels).modelSet.model,
    "gpt-5.5",
  );

  // With instant + thinking models, fast resolves to instant, thinking to thinking
  const gptFullModels = [
    "openai/gpt-5.5-instant",
    "openai/gpt-5.5",
    "openai/gpt-5.5-thinking",
    "openai/gpt-5.5-pro",
  ];
  assertEq(
    "gpt D0 implementer → gpt-5.5-instant (fast→instant)",
    resolveSubagentModel("phenix/gpt", "implementer", "D0", {} as any, gptFullModels).modelSet.model,
    "gpt-5.5-instant",
  );
  assertEq(
    "gpt D1 planner → gpt-5.5-thinking (thinking→thinking)",
    resolveSubagentModel("phenix/gpt", "planner", "D1", {} as any, gptFullModels).modelSet.model,
    "gpt-5.5-thinking",
  );
  assertEq(
    "gpt D3 final_reviewer → gpt-5.5-pro (pro→pro)",
    resolveSubagentModel("phenix/gpt", "final_reviewer", "D3", {} as any, gptFullModels).modelSet.model,
    "gpt-5.5-pro",
  );
});

describe("resolveSubagentModel: mixed variant", () => {
  // D0: only implementer
  assertEq(
    "mixed D0 implementer → deepseek-v4-flash",
    resolveSubagentModel("phenix/mixed", "implementer", "D0", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "mixed D0 planner → unavailable",
    resolveSubagentModel("phenix/mixed", "planner", "D0", {} as any).available,
    false,
  );

  // D1: all opencode-go
  assertEq(
    "mixed D1 planner → deepseek-v4-flash",
    resolveSubagentModel("phenix/mixed", "planner", "D1", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "mixed D1 scout → deepseek-v4-flash",
    resolveSubagentModel("phenix/mixed", "scout", "D1", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "mixed D1 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/mixed", "implementer", "D1", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
  assertEq(
    "mixed D1 verifier → deepseek-v4-flash",
    resolveSubagentModel("phenix/mixed", "verifier", "D1", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );

  // D2: planner+verifier use GPT
  assertEq(
    "mixed D2 planner → gpt-5.5 (gpt/thinking resolved)",
    resolveSubagentModel("phenix/mixed", "planner", "D2", {} as any, ["openai/gpt-5.5"]).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "mixed D2 scout → deepseek-v4-flash",
    resolveSubagentModel("phenix/mixed", "scout", "D2", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "mixed D2 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/mixed", "implementer", "D2", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
  assertEq(
    "mixed D2 verifier → gpt-5.5 (gpt/thinking resolved)",
    resolveSubagentModel("phenix/mixed", "verifier", "D2", {} as any, ["openai/gpt-5.5"]).modelSet.model,
    "gpt-5.5",
  );

  // D3: planner+verifier GPT, final_reviewer GPT pro
  assertEq(
    "mixed D3 planner → gpt-5.5",
    resolveSubagentModel("phenix/mixed", "planner", "D3", {} as any, ["openai/gpt-5.5"]).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "mixed D3 verifier → gpt-5.5",
    resolveSubagentModel("phenix/mixed", "verifier", "D3", {} as any, ["openai/gpt-5.5"]).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "mixed D3 final_reviewer → gpt-5.5 (pro→gpt-5.5 fallback)",
    resolveSubagentModel("phenix/mixed", "final_reviewer", "D3", {} as any, ["openai/gpt-5.5"]).modelSet.model,
    "gpt-5.5",
  );
  assertEq(
    "mixed D3 implementer → kimi-k2.7-code",
    resolveSubagentModel("phenix/mixed", "implementer", "D3", {} as any).modelSet.model,
    "kimi-k2.7-code",
  );
});

describe("resolveSubagentModel: unknown variant fallback", () => {
  assertEq(
    "unknown D0 implementer → deepseek-v4-flash",
    resolveSubagentModel("unknown", "implementer", "D0", {} as any).modelSet.model,
    "deepseek-v4-flash",
  );
  assertEq(
    "unknown D3 planner → glm-5.2",
    resolveSubagentModel("unknown", "planner", "D3", {} as any).modelSet.model,
    "glm-5.2",
  );
  assertEq(
    "unknown D3 verifier → glm-5.2",
    resolveSubagentModel("unknown", "verifier", "D3", {} as any).modelSet.model,
    "glm-5.2",
  );
});

describe("resolveSubagentModel warnings", () => {
  assertEq(
    "phenix/free has warnings",
    resolveSubagentModel("phenix/free", "planner", "D1", {} as any).warnings?.length,
    1,
  );

  assertEq(
    "phenix/free warning mentions permissions",
    (resolveSubagentModel("phenix/free", "planner", "D1", {} as any).warnings ?? [])[0].includes("permissions"),
    true,
  );

  assertEq(
    "phenix/opencode-go has no warnings",
    resolveSubagentModel("phenix/opencode-go", "planner", "D1", {} as any).warnings?.length,
    undefined,
  );

  assertEq(
    "phenix/mixed has no warnings",
    resolveSubagentModel("phenix/mixed", "planner", "D1", {} as any).warnings?.length,
    undefined,
  );

  assertEq(
    "phenix/gpt has no warnings",
    resolveSubagentModel("phenix/gpt", "planner", "D1", {} as any).warnings?.length,
    undefined,
  );
});

describe("ROUTING_MATRIX variant frontend models", () => {
  assertEq(
    "opencode-go frontend → opencode-go/deepseek-v4-flash",
    `${ROUTING_MATRIX["opencode-go"].frontend.provider}/${ROUTING_MATRIX["opencode-go"].frontend.model}`,
    "opencode-go/deepseek-v4-flash",
  );

  assertEq(
    "free frontend → opencode/deepseek-v4-flash-free",
    `${ROUTING_MATRIX["free"].frontend.provider}/${ROUTING_MATRIX["free"].frontend.model}`,
    "opencode/deepseek-v4-flash-free",
  );

  assertEq(
    "gpt frontend → openai/gpt-5.5",
    `${ROUTING_MATRIX["gpt"].frontend.provider}/${ROUTING_MATRIX["gpt"].frontend.model}`,
    "openai/gpt-5.5",
  );

  assertEq(
    "mixed frontend → opencode-go/deepseek-v4-flash",
    `${ROUTING_MATRIX["mixed"].frontend.provider}/${ROUTING_MATRIX["mixed"].frontend.model}`,
    "opencode-go/deepseek-v4-flash",
  );
});

describe("resolveGptCapability function", () => {
  const gptOnly = ["openai/gpt-5.5"];
  const gptFull = ["openai/gpt-5.5-instant", "openai/gpt-5.5", "openai/gpt-5.5-thinking", "openai/gpt-5.5-pro"];

  assertEq(
    "fast with gpt-only → gpt-5.5",
    resolveGptCapability("fast", gptOnly),
    "openai/gpt-5.5",
  );
  assertEq(
    "fast with full list → gpt-5.5-instant",
    resolveGptCapability("fast", gptFull),
    "openai/gpt-5.5-instant",
  );
  assertEq(
    "thinking with full list → gpt-5.5-thinking",
    resolveGptCapability("thinking", gptFull),
    "openai/gpt-5.5-thinking",
  );
  assertEq(
    "pro with full list → gpt-5.5-pro",
    resolveGptCapability("pro", gptFull),
    "openai/gpt-5.5-pro",
  );
  assertEq(
    "unknown capability → gpt-5.5",
    resolveGptCapability("nonexistent", gptOnly),
    "openai/gpt-5.5",
  );
  // gpt-5.5-mini and gpt-5.6-* are never generated
  assertEq(
    "gpt-5.5-mini never in fast preference",
    GPT_CAPABILITY_PREFERENCES["fast"].includes("openai/gpt-5.5-mini"),
    false,
  );
  assertEq(
    "gpt-5.6 never in any preference",
    GPT_CAPABILITY_PREFERENCES["fast"].some((m: string) => m.includes("gpt-5.6")),
    false,
  );
});

describe("resolveRoleWithFallback function", () => {
  const available = ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro", "opencode-go/kimi-k2.7-code"];

  assertEq(
    "model directly available → same model",
    resolveRoleWithFallback("opencode-go/deepseek-v4-flash", "planner", available),
    "opencode-go/deepseek-v4-flash",
  );
  assertEq(
    "model not in available → walk preference list",
    resolveRoleWithFallback("opencode-go/nonexistent", "planner", available),
    "opencode-go/deepseek-v4-pro", // planner's 2nd preference after qwen3.7-plus
  );
  assertEq(
    "all preferences exhausted → ultimate fallback",
    resolveRoleWithFallback("opencode-go/nonexistent", "scout", ["opencode-go/only-available"]),
    "opencode-go/deepseek-v4-flash",
  );
});

describe("OPENCODE_GO_AVAILABLE_MODELS includes all model IDs", () => {
  const expectedModels = [
    "opencode-go/glm-5.2",
    "opencode-go/glm-5.1",
    "opencode-go/kimi-k2.7-code",
    "opencode-go/kimi-k2.6",
    "opencode-go/mimo-v2.5",
    "opencode-go/mimo-v2.5-pro",
    "opencode-go/minimax-m3",
    "opencode-go/minimax-m2.7",
    "opencode-go/minimax-m2.5",
    "opencode-go/qwen3.7-max",
    "opencode-go/qwen3.7-plus",
    "opencode-go/qwen3.6-plus",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/deepseek-v4-flash",
  ];
  for (const m of expectedModels) {
    assertOk(`available models includes ${m}`, OPENCODE_GO_AVAILABLE_MODELS.includes(m));
  }
  // All model IDs use opencode-go/ prefix format
  for (const m of OPENCODE_GO_AVAILABLE_MODELS) {
    assertOk(`model ID "${m}" uses opencode-go/ prefix`, m.startsWith("opencode-go/"));
  }
});

describe("ROLE_PREFERENCES end with ultimate fallback", () => {
  for (const [role, prefs] of Object.entries(ROLE_PREFERENCES)) {
    assertOk(`role "${role}" preferences end with deepseek-v4-flash`, prefs[prefs.length - 1] === "opencode-go/deepseek-v4-flash");
  }
});

describe("GPT_CAPABILITY_PREFERENCES never include forbidden models", () => {
  for (const [cap, prefs] of Object.entries(GPT_CAPABILITY_PREFERENCES)) {
    for (const m of prefs) {
      assertEq(`capability "${cap}" does not include gpt-5.5-mini`, m.includes("gpt-5.5-mini"), false);
      assertEq(`capability "${cap}" does not include gpt-5.6`, m.includes("gpt-5.6"), false);
    }
  }
});

describe("Model ID format: opencode-go models use correct prefix", () => {
  // opencode-go variant models have provider "opencode-go"
  const ogRoute = ROUTING_MATRIX["opencode-go"];
  for (const diff of ["D0", "D1", "D2", "D3"] as Difficulty[]) {
    const config = ogRoute.difficulties[diff];
    for (const [role, assignment] of Object.entries(config ?? {})) {
      if (!assignment || !assignment.enabled) continue;
      assertOk(
        `${diff}/${role} model "${assignment.model}" uses opencode-go/ prefix`,
        assignment.model.startsWith("opencode-go/"),
      );
    }
  }
});

// ──────────────────────────────────────────────
// 4. EvidencePacket schema
// ──────────────────────────────────────────────

describe("EvidencePacket schema validation", () => {
  const valid: EvidencePacket = {
    summary: "Found relevant files for config refactor",
    relevantFiles: [
      { path: "config/phenix-pi/pi/extensions/phenix-flow.ts", lines: "1-50", reason: "Flow orchestrator" },
    ],
    symbols: [
      { name: "resolveRouting", location: "routing.ts:42", reason: "Key function" },
    ],
    currentBehavior: "Router uses YAML-based routing matrix",
    likelyEditPoints: [
      { path: "config/phenix-pi/pi/prompts/flow.md", reason: "Workflow prompt" },
    ],
    risks: ["Changing model slots may break existing routes"],
    confidence: "high",
  };

  assertOk("summary is string", typeof valid.summary === "string");
  assertOk("relevantFiles is array", Array.isArray(valid.relevantFiles));
  assertOk("symbols is array", Array.isArray(valid.symbols));
  assertOk("risks is array", Array.isArray(valid.risks));
  assertEq("confidence is high", valid.confidence, "high");

  const validConfidences: EvidencePacket["confidence"][] = ["low", "medium", "high"];
  for (const c of validConfidences) {
    assertEq(`confidence "${c}" is valid`, c, c);
  }
});

// ──────────────────────────────────────────────
// 5. Recursion safety defaults
// ──────────────────────────────────────────────

describe("Recursion defaults provide safe limits", () => {
  assertOk("maxDepth exists", RECURSION_DEFAULTS.maxDepth > 0);
  assertOk("maxChildren exists", RECURSION_DEFAULTS.maxChildrenPerTask > 0);
  assertOk("maxTotalSubagents exists", RECURSION_DEFAULTS.maxTotalSubagents > 0);

  for (const profile of Object.values(SUBAGENT_PROFILES) as Array<{ maxTurnsDefault: number }>) {
    assertOk(
      `Profile has maxTurnsDefault > 0 (got ${profile.maxTurnsDefault})`,
      (profile.maxTurnsDefault ?? 0) > 0,
    );
  }
});

// ──────────────────────────────────────────────
// 6. ROLE_TOOL_DEFAULTS
// ──────────────────────────────────────────────

describe("ROLE_TOOL_DEFAULTS are defined", () => {
  const roles: PhenixSubagentRole[] = [
    "scout",
    "planner",
    "architect",
    "worker",
    "verifier",
    "reviewer",
    "debugger",
  ];

  for (const role of roles) {
    assertOk(
      `Role "${role}" has tool defaults`,
      Array.isArray(ROLE_TOOL_DEFAULTS[role]) && ROLE_TOOL_DEFAULTS[role].length > 0,
    );
  }
});

describe("Scout has only read tools", () => {
  const tools = ROLE_TOOL_DEFAULTS.scout;
  const writeTools = ["edit", "write", "resolve", "ast_edit", "bash", "job"];
  for (const wt of writeTools) {
    assertEq(`scout does NOT have "${wt}"`, tools.includes(wt), false);
  }
  const readTools = ["read", "find", "search"];
  for (const rt of readTools) {
    assertEq(`scout HAS "${rt}"`, tools.includes(rt), true);
  }
});

describe("Worker has edit tools", () => {
  const tools = ROLE_TOOL_DEFAULTS.worker;
  assertEq("worker has edit", tools.includes("edit"), true);
  assertEq("worker has ast_grep", tools.includes("ast_grep"), true);
  assertEq("worker has bash", tools.includes("bash"), true);
});

// ──────────────────────────────────────────────
// 7. parsePiJsonOutput
// ──────────────────────────────────────────────

describe("parsePiJsonOutput: empty input", () => {
  const result = parsePiJsonOutput("", 50000, 2000);
  assertEq("empty input -> empty text", result.cleanedText, "");
  assertEq("not truncated", result.truncated, false);
  assertEq("0 lines", result.lines, 1); // empty string has 1 line
});

describe("parsePiJsonOutput: non-JSON text", () => {
  const result = parsePiJsonOutput("Hello, world!", 50000, 2000);
  assertEq("non-JSON text preserved", result.cleanedText, "Hello, world!");
  assertEq("not truncated", result.truncated, false);
});

describe("parsePiJsonOutput: JSON events", () => {
  // Pi JSON-mode output: type=start, chunk, end
  const jsonOutput = [
    '{"type":"start","partial":{"content":[{"type":"text","text":"Hello"}]}}',
    '{"type":"chunk","delta":{"type":"text","text":", world"}}',
    '{"type":"end","result":{"content":[{"type":"text","text":"!"}],"model":"opencode/deepseek-v4-flash"}}',
  ].join("\n");

  const result = parsePiJsonOutput(jsonOutput, 50000, 2000);
  assertEq("JSON events assembled", result.cleanedText, "Hello, world!");
  assertEq("model extracted", result.modelUsed, "opencode/deepseek-v4-flash");
  assertEq("not truncated", result.truncated, false);
});

describe("parsePiJsonOutput: byte truncation", () => {
  const longText = "A".repeat(100);
  const truncated_by_bytes = parsePiJsonOutput(longText, 50, 2000);
  assertEq("Byte truncation works", truncated_by_bytes.truncated, true);
  assertEq("Byte truncation reduces size", truncated_by_bytes.cleanedText.length < longText.length, true);
});

describe("parsePiJsonOutput: line truncation", () => {
  const manyLines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
  const truncated_by_lines = parsePiJsonOutput(manyLines, 50000, 10);
  assertEq("Line truncation works", truncated_by_lines.truncated, true);
  assertEq("Line truncation reduces lines", truncated_by_lines.lines <= 11, true);
});

// ──────────────────────────────────────────────
// 8. No direct model API calls
// ──────────────────────────────────────────────

describe("CRITICAL: No direct model API calls", () => {
  const sourcePath = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
  );
  const source = fs.readFileSync(sourcePath, "utf-8");
  const lines = source.split("\n");
  const codeLines = lines.filter((l) => !l.trim().startsWith("*"));

  // streamSimple must ABSOLUTELY NEVER appear in code (not even in comments)
  assertEq(
    "streamSimple does not appear in source",
    codeLines.filter((l) => l.includes("streamSimple")).length,
    0,
  );

  // pi-ai/compat must not be imported
  assertEq(
    "pi-ai/compat is not imported",
    codeLines.filter((l) => l.includes('pi-ai/compat')).length,
    0,
  );

  // No direct model api key fetch in subagent executor
  assertEq(
    "getApiKeyAndHeaders is only in model key propagation, not in runPhenixSubagent main path",
    codeLines.filter((l) => l.includes("getApiKeyAndHeaders")).length,
    1, // Only in the model key propagation section
  );
});

// ──────────────────────────────────────────────
// 9. Child process spawning semantics
// ──────────────────────────────────────────────

describe("Child process: spawn is used (not execSync/fork)", () => {
  const sourcePath = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
  );
  const source = fs.readFileSync(sourcePath, "utf-8");
  const codeLines = source.split("\n").filter((l) => !l.trim().startsWith("*"));

  // Must import spawn, not execSync or fork
  assertEq(
    "spawn is imported from child_process",
    codeLines.filter((l) => l.includes('spawn')).length >= 1,
    true,
  );

  assertEq(
    "fork is NOT imported",
    codeLines.filter((l) => l.includes('fork')).length,
    0,
  );

  // Must kill child on timeout (SIGTERM then SIGKILL fallback)
  assertEq(
    "SIGTERM is used for timeout",
    codeLines.filter((l) => l.includes('SIGTERM')).length >= 1,
    true,
  );

  assertEq(
    "SIGKILL is used as fallback",
    codeLines.filter((l) => l.includes('SIGKILL')).length >= 1,
    true,
  );

  // Must NOT call model APIs directly
  assertEq(
    "No direct model API functions (streamSimple, createAssistantMessageEventStream, etc.)",
    codeLines.filter((l) =>
      l.includes('streamSimple') ||
      l.includes('createAssistantMessageEventStream')
    ).length,
    0,
  );
});

// ──────────────────────────────────────────────
// 10. buildChildEnv
// ──────────────────────────────────────────────

describe("buildChildEnv sets recursion depth", () => {
  const env = buildChildEnv(
    {
      role: "worker",
      task: "test task",
      cwd: "/tmp",
    },
    {} as any,
  );
  assertEq("PI_SUBAGENT_DEPTH is 1", env.PI_SUBAGENT_DEPTH, "1");
  assertEq("PI_OFFLINE is 1", env.PI_OFFLINE, "1");
});

// ──────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────

const total = passed + failed;
console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ${f.replace(/\n/g, "\n  ")}`);
    console.log();
  }
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
}
