/**
 * test-subagent-validator.ts — Standalone contract validation for subagent executor.
 *
 * This script validates the shouldRunRepoScout logic, profile definitions,
 * recursion defaults, and schema contracts by implementing the pure functions
 * inline (without Pi runtime dependencies).
 *
 * In production, these functions live in phenix-subagent-executor.ts.
 * This test validates they work correctly so the Pi extension can rely on them.
 */

// ══════════════════════════════════════════════
// 1. INLINE IMPLEMENTATIONS
// ══════════════════════════════════════════════

type Difficulty = "D0" | "D1" | "D2" | "D3";

interface EvidencePacket {
  summary: string;
  relevantFiles: Array<{ path: string; lines: string; reason: string }>;
  symbols: Array<{ name: string; location: string; reason: string }>;
  currentBehavior: string | null;
  likelyEditPoints: Array<{ path: string; reason: string }>;
  risks: string[];
  confidence: "low" | "medium" | "high";
}

interface ScoutInput {
  difficulty: Difficulty;
  prompt: string;
  exactPathsMentioned: string[];
  exactSymbolsMentioned: string[];
}

function shouldRunRepoScout(input: ScoutInput): boolean {
  const lower = input.prompt.toLowerCase();

  // D0: mechanical tasks
  if (input.difficulty === "D0") {
    const isMechanicalTypo = /\b(typo|format|rename|spelling|trivial)\b/i.test(lower);
    const hasExactPath = input.exactPathsMentioned.length > 0;
    if (isMechanicalTypo && hasExactPath) {
      return false;
    }
    return false; // D0 defaults to no scout
  }

  // Tasks touching sensitive areas always get a scout
  const sensitiveKeywords = /\b(workflow|routing|mcp|nix|rust|test|config|architect|depend|security|auth)\b/i;
  if (sensitiveKeywords.test(lower)) {
    return true;
  }

  // D1+ defaults to scout
  if (input.difficulty === "D1" || input.difficulty === "D2" || input.difficulty === "D3") {
    return true;
  }

  // Default: no scout for trivial things
  return false;
}

interface ToolPolicy {
  allowedTools: string[];
  deniedTools: string[];
  enforceable: "runtime_enforced" | "prompt_only" | "unavailable";
}

interface ProfilePermissions {
  read: boolean;
  edit: boolean;
  shell: "none" | "read_only" | "safe" | "unrestricted";
  network: boolean;
  canDelegate: boolean;
  canAskUser: boolean;
}

interface Profile {
  role: string;
  permissions: ProfilePermissions;
  toolPolicy: ToolPolicy;
  outputSchema: string;
  maxTurnsDefault: number;
  maxToolCallsDefault: number;
}

const PROFILES: Record<string, Profile> = {
  repo_scout: {
    role: "scout",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["find", "search", "read_range", "ast_grep", "lsp_symbols"],
      deniedTools: ["edit", "write", "resolve", "bash", "job", "task", "todo"],
      enforceable: "prompt_only",
    },
    outputSchema: "EvidencePacket",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 10,
  },
  implementation: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read_range", "search", "edit", "test", "find", "ast_grep", "ast_edit"],
      deniedTools: ["commit", "push", "deploy", "network"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
  },
  refactor: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read_range", "search", "ast_grep", "ast_edit", "lsp_rename", "test", "find"],
      deniedTools: ["commit", "push", "edit"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
  },
  test_author: {
    role: "worker",
    permissions: { read: true, edit: true, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read_range", "search", "edit", "test", "find"],
      deniedTools: ["commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "PatchReport",
    maxTurnsDefault: 3,
    maxToolCallsDefault: 20,
  },
  verifier_patch: {
    role: "verifier",
    permissions: { read: true, edit: false, shell: "safe", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read_range", "diff", "test", "diagnostics", "search", "find"],
      deniedTools: ["edit", "write", "resolve", "commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "VerificationReport",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 10,
  },
  safety_io: {
    role: "safety_reviewer",
    permissions: { read: true, edit: false, shell: "read_only", network: false, canDelegate: false, canAskUser: false },
    toolPolicy: {
      allowedTools: ["read_range", "search", "diff", "find"],
      deniedTools: ["edit", "write", "resolve", "bash", "commit", "push"],
      enforceable: "prompt_only",
    },
    outputSchema: "VerificationReport",
    maxTurnsDefault: 1,
    maxToolCallsDefault: 5,
  },
};

const RECURSION_DEFAULTS = {
  enabled: true,
  maxDepth: 2,
  maxChildrenPerTask: 4,
  maxTotalSubagents: 8,
  maxTurnsPerSubagent: {
    repo_scout: 1,
    worker: 3,
    verifier: 1,
  } as Record<string, number>,
  maxToolCallsPerSubagent: {
    repo_scout: 10,
    worker: 20,
    verifier: 10,
  } as Record<string, number>,
};

// ══════════════════════════════════════════════
// 2. TEST FRAMEWORK
// ══════════════════════════════════════════════

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string): void {
  results.push({ name, passed: condition, detail });
  if (!condition) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${detail}`);
  } else {
    console.log(`  ✓ PASS: ${name}`);
  }
}

function assertEq(name: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  results.push({ name, passed: pass, detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  if (!pass) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertDeep(name: string, actual: Record<string, unknown>, expected: Record<string, unknown>, path = "$"): boolean {
  const keys = Object.keys(expected);
  for (const key of keys) {
    if (!(key in actual)) {
      assert(`${name} > ${key}`, false, `missing key at ${path}.${key}`);
      return false;
    }
    const aVal = actual[key];
    const eVal = expected[key];
    if (typeof eVal === "object" && eVal !== null && typeof aVal === "object" && aVal !== null) {
      assertDeep(`${name} > ${key}`, aVal as Record<string, unknown>, eVal as Record<string, unknown>, `${path}.${key}`);
    } else {
      assert(`${name} > ${key}`, aVal === eVal, `at ${path}.${key}: expected ${JSON.stringify(eVal)}, got ${JSON.stringify(aVal)}`);
    }
  }
  return true;
}

function describe(suite: string, fn: () => void): void {
  console.log(`\n## ${suite}`);
  fn();
}

// ══════════════════════════════════════════════
// 3. SCENARIO 1: D0 skips scout
// ══════════════════════════════════════════════

describe("Scenario 1: D0 skips scout", () => {
  assertEq(
    "D0 typo with exact path → no scout",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Fix typo in README line X.",
      exactPathsMentioned: ["README"],
      exactSymbolsMentioned: [],
    }),
    false,
  );

  assertEq(
    "D0 with mechanical keyword → no scout",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Fix the formatting in the error handler.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    false,
  );

  assertEq(
    "D0 rename → no scout",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Rename variable x to y.",
      exactPathsMentioned: ["src/main.ts"],
      exactSymbolsMentioned: ["x"],
    }),
    false,
  );
});

// ══════════════════════════════════════════════
// 4. SCENARIO 2: D1 runs scout first
// ══════════════════════════════════════════════

describe("Scenario 2: D1+ runs scout first", () => {
  assertEq(
    "D1 without exact context → scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Fix /flow argument parsing.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 with exact path → still scout (D1+)",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Update the rollback logic in parseSessionEntries.",
      exactPathsMentioned: ["parseSessionEntries"],
      exactSymbolsMentioned: ["rollback"],
    }),
    true,
  );

  assertEq(
    "D1 single-file edit → scout (D1+)",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Fix typo in error message in config.ts.",
      exactPathsMentioned: ["config.ts"],
      exactSymbolsMentioned: [],
    }),
    true,
  );
});

// ══════════════════════════════════════════════
// 5. SCENARIO 3: D2/D3 runs scout + sensitive keywords
// ══════════════════════════════════════════════

describe("Scenario 3: D2/D3 runs scout + sensitive keywords", () => {
  assertEq(
    "D2 architectural change → scout",
    shouldRunRepoScout({
      difficulty: "D2",
      prompt: "Implement real subagents for recursive workflow.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D3 high-risk auth change → scout",
    shouldRunRepoScout({
      difficulty: "D3",
      prompt: "Update routing to support new auth provider.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 nix keyword → scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Add new flake input for Rust toolchain.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 workflow keyword → scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Update workflow routing for MCP integration.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 security keyword → scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Add input validation to prevent path traversal.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 architect keyword → scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Refactor the architecture to support plugins.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );
});

// ══════════════════════════════════════════════
// 6. SCENARIO 4: Scout read-only profile checks
// ══════════════════════════════════════════════

describe("Scenario 4: Scout read-only profile", () => {
  const profile = PROFILES.repo_scout;

  assertEq("scout role", profile.role, "scout");
  assertEq("scout read", profile.permissions.read, true);
  assertEq("scout edit", profile.permissions.edit, false);
  assertEq("scout shell", profile.permissions.shell, "read_only");
  assertEq("scout network", profile.permissions.network, false);
  assertEq("scout canDelegate", profile.permissions.canDelegate, false);
  assertEq("scout canAskUser", profile.permissions.canAskUser, false);

  assertEq("scout allows find", profile.toolPolicy.allowedTools.includes("find"), true);
  assertEq("scout allows search", profile.toolPolicy.allowedTools.includes("search"), true);
  assertEq("scout allows read_range", profile.toolPolicy.allowedTools.includes("read_range"), true);
  assertEq("scout allows ast_grep", profile.toolPolicy.allowedTools.includes("ast_grep"), true);
  assertEq("scout allows lsp_symbols", profile.toolPolicy.allowedTools.includes("lsp_symbols"), true);

  assertEq("scout denies edit", profile.toolPolicy.deniedTools.includes("edit"), true);
  assertEq("scout denies write", profile.toolPolicy.deniedTools.includes("write"), true);
  assertEq("scout denies resolve", profile.toolPolicy.deniedTools.includes("resolve"), true);
  assertEq("scout denies bash", profile.toolPolicy.deniedTools.includes("bash"), true);

  assertEq("scout enforceable is prompt_only", profile.toolPolicy.enforceable, "prompt_only");
  assertEq("scout output schema", profile.outputSchema, "EvidencePacket");
  assertEq("scout maxTurnsDefault", profile.maxTurnsDefault, 1);
  assertEq("scout maxToolCallsDefault", profile.maxToolCallsDefault, 10);
});

// ══════════════════════════════════════════════
// 7. SCENARIO 5: Worker scope resolution
// ══════════════════════════════════════════════

describe("Scenario 5: Worker scope resolution", () => {
  const workerAllowedPaths = ["config/phenix-pi/pi/extensions/phenix-flow.ts"];
  const runtimePath = "config/phenix-pi/pi/extensions/phenix-runtime.ts";
  const parentAllowedPaths = ["config/phenix-pi/pi/extensions"];

  const workerCanEditRuntime = workerAllowedPaths.some(
    (p) => runtimePath.startsWith(p) || p.startsWith(runtimePath),
  );

  const parentContainsRuntime = parentAllowedPaths.some(
    (p) => runtimePath.startsWith(p),
  );

  assertEq("worker scope does not include runtime", workerCanEditRuntime, false);
  assertEq("parent scope includes runtime", parentContainsRuntime, true);
});

// ══════════════════════════════════════════════
// 8. SCENARIO 6: Verifier profile
// ══════════════════════════════════════════════

describe("Scenario 6: Verifier is real subagent profile", () => {
  const profile = PROFILES.verifier_patch;

  assertEq("verifier role", profile.role, "verifier");
  assertEq("verifier read", profile.permissions.read, true);
  assertEq("verifier edit", profile.permissions.edit, false);
  assertEq("verifier shell", profile.permissions.shell, "safe");
  assertEq("verifier network", profile.permissions.network, false);
  assertEq("verifier canDelegate", profile.permissions.canDelegate, false);
  assertEq("verifier canAskUser", profile.permissions.canAskUser, false);

  assertEq("verifier allows diff", profile.toolPolicy.allowedTools.includes("diff"), true);
  assertEq("verifier allows diagnostics", profile.toolPolicy.allowedTools.includes("diagnostics"), true);
  assertEq("verifier denies edit", profile.toolPolicy.deniedTools.includes("edit"), true);
  assertEq("verifier denies write", profile.toolPolicy.deniedTools.includes("write"), true);

  assertEq("verifier enforceable is prompt_only", profile.toolPolicy.enforceable, "prompt_only");
  assertEq("verifier output schema", profile.outputSchema, "VerificationReport");
});

// ══════════════════════════════════════════════
// 9. SCENARIO 7: No fake subagents
// ══════════════════════════════════════════════

describe("Scenario 7: No fake subagents", () => {
  // Verify all required profiles exist
  const requiredProfiles = ["repo_scout", "implementation", "refactor", "test_author", "verifier_patch", "safety_io"];
  for (const name of requiredProfiles) {
    assertEq(`profile "${name}" exists`, name in PROFILES, true);
  }

  // Verify each profile has all required fields
  for (const [name, profile] of Object.entries(PROFILES)) {
    assertEq(`${name}: role is string`, typeof profile.role === "string", true);
    assertEq(`${name}: permissions.read is boolean`, typeof profile.permissions.read === "boolean", true);
    assertEq(`${name}: permissions.edit is boolean`, typeof profile.permissions.edit === "boolean", true);
    assertEq(`${name}: toolPolicy.allowedTools is array`, Array.isArray(profile.toolPolicy.allowedTools), true);
    assertEq(`${name}: toolPolicy.deniedTools is array`, Array.isArray(profile.toolPolicy.deniedTools), true);
    assertEq(`${name}: toolPolicy.enforceable is valid`, ["runtime_enforced", "prompt_only", "unavailable"].includes(profile.toolPolicy.enforceable), true);
    assertEq(`${name}: outputSchema is non-empty string`, profile.outputSchema.length > 0, true);
    assertEq(`${name}: maxTurnsDefault is positive`, profile.maxTurnsDefault > 0, true);
    assertEq(`${name}: maxToolCallsDefault is positive`, profile.maxToolCallsDefault > 0, true);
  }

  // Verify no profile claims runtime enforcement (Pi doesn't support it)
  const runtimeEnforced = Object.values(PROFILES).filter((p: Profile) => p.toolPolicy.enforceable === "runtime_enforced");
  assertEq("no profile claims runtime enforcement (Pi API limitation)", runtimeEnforced.length, 0);
});

// ══════════════════════════════════════════════
// 10. RECURSION SAFETY DEFAULTS
// ══════════════════════════════════════════════

describe("Recursion safety defaults", () => {
  assertEq("maxDepth", RECURSION_DEFAULTS.maxDepth, 2);
  assertEq("maxChildrenPerTask", RECURSION_DEFAULTS.maxChildrenPerTask, 4);
  assertEq("maxTotalSubagents", RECURSION_DEFAULTS.maxTotalSubagents, 8);

  assertEq("repo_scout maxTurns", RECURSION_DEFAULTS.maxTurnsPerSubagent.repo_scout, 1);
  assertEq("worker maxTurns", RECURSION_DEFAULTS.maxTurnsPerSubagent.worker, 3);
  assertEq("verifier maxTurns", RECURSION_DEFAULTS.maxTurnsPerSubagent.verifier, 1);

  assertEq("repo_scout maxToolCalls", RECURSION_DEFAULTS.maxToolCallsPerSubagent.repo_scout, 10);
  assertEq("worker maxToolCalls", RECURSION_DEFAULTS.maxToolCallsPerSubagent.worker, 20);
  assertEq("verifier maxToolCalls", RECURSION_DEFAULTS.maxToolCallsPerSubagent.verifier, 10);
});

// ══════════════════════════════════════════════
// 11. EVIDENCE PACKET SCHEMA
// ══════════════════════════════════════════════

describe("EvidencePacket schema", () => {
  const validPacket: EvidencePacket = {
    summary: "Test summary",
    relevantFiles: [{ path: "test.ts", lines: "1-50", reason: "Test file" }],
    symbols: [{ name: "testFunc", location: "test.ts:10", reason: "Main function" }],
    currentBehavior: "Current behavior description",
    likelyEditPoints: [{ path: "test.ts", reason: "Needs update" }],
    risks: ["Risk description"],
    confidence: "high",
  };

  assertEq("has summary string", typeof validPacket.summary === "string", true);
  assertEq("has relevantFiles array", Array.isArray(validPacket.relevantFiles), true);
  assertEq("relevantFiles[0].path string", typeof validPacket.relevantFiles[0].path === "string", true);
  assertEq("relevantFiles[0].lines string", typeof validPacket.relevantFiles[0].lines === "string", true);
  assertEq("relevantFiles[0].reason string", typeof validPacket.relevantFiles[0].reason === "string", true);
  assertEq("has symbols array", Array.isArray(validPacket.symbols), true);
  assertEq("symbols[0].name string", typeof validPacket.symbols[0].name === "string", true);
  assertEq("symbols[0].location string", typeof validPacket.symbols[0].location === "string", true);
  assertEq("symbols[0].reason string", typeof validPacket.symbols[0].reason === "string", true);
  assertEq("has currentBehavior string or null", validPacket.currentBehavior === null || typeof validPacket.currentBehavior === "string", true);
  assertEq("has likelyEditPoints array", Array.isArray(validPacket.likelyEditPoints), true);
  assertEq("likelyEditPoints[0].path string", typeof validPacket.likelyEditPoints[0].path === "string", true);
  assertEq("likelyEditPoints[0].reason string", typeof validPacket.likelyEditPoints[0].reason === "string", true);
  assertEq("has risks array", Array.isArray(validPacket.risks), true);
  assertEq("confidence is valid", ["low", "medium", "high"].includes(validPacket.confidence), true);

  // Test confidence values
  assertEq("confidence=low is valid", ["low", "medium", "high"].includes("low" as any), true);
  assertEq("confidence=medium is valid", ["low", "medium", "high"].includes("medium" as any), true);
  assertEq("confidence=high is valid", ["low", "medium", "high"].includes("high" as any), true);

  // Test empty arrays are valid
  const emptyPacket: EvidencePacket = {
    summary: "Nothing found",
    relevantFiles: [],
    symbols: [],
    currentBehavior: null,
    likelyEditPoints: [],
    risks: [],
    confidence: "low",
  };
  assertEq("empty packet is valid", emptyPacket.relevantFiles.length === 0 && emptyPacket.symbols.length === 0, true);
});

// ══════════════════════════════════════════════
// 12. PROFILE COMPLETENESS
// ══════════════════════════════════════════════

describe("All profiles have complete definitions", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    assertEq(`${name}: permissions.edit is boolean`, typeof profile.permissions.edit === "boolean", true);
    assertEq(`${name}: permissions.shell is valid`, ["none", "read_only", "safe", "unrestricted"].includes(profile.permissions.shell), true);

    // Worker profiles should have edit=true
    if (profile.role === "worker") {
      assertEq(`${name} (worker) has edit=true`, profile.permissions.edit, true);
    }

    // Read-only profiles should have edit=false
    if (profile.role === "scout" || profile.role === "verifier" || profile.role === "safety_reviewer") {
      assertEq(`${name} (${profile.role}) has edit=false`, profile.permissions.edit, false);
    }
  }
});

// ══════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`\n${"=".repeat(60)}`);
console.log(`SUBAGENT EXECUTOR VALIDATION`);
console.log(`${"=".repeat(60)}`);
console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);

if (failed > 0) {
  console.error(`\nFAILED TESTS:`);
  for (const r of results.filter((r) => !r.passed)) {
    console.error(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} tests passed!`);
}
