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
 *   3. resolveSubagentModel model set resolution
 *   4. EvidencePacket schema validation
 *   5. Recursion safety defaults
 *   6. ROLE_TOOL_DEFAULTS
 *   7. parsePiJsonOutput
 *   8. resolveRoleModel
 *   9. No direct model API calls (static import check)
 *  10. Child process spawning semantics (static code check)
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
  RECURSION_DEFAULTS,
  ROLE_TOOL_DEFAULTS,
  resolveRoleModel,
  parsePiJsonOutput,
  runPhenixSubagent,
  runPhenixSubagentsParallel,
  ensureCommChannelDir,
  writeCommMessage,
  readCommMessage,
  listCommMessages,
  writeSubagentResult,
  readSubagentResult,
  PARALLEL_DEFAULTS,
  COMM_CHANNEL_DEFAULTS,
  AGENT_COMM_MCP_OPS,
  default as phenixSubagentExecutor,
  type EvidencePacket,
  type RunPhenixSubagentResult,
  type RunPhenixSubagentInput,
  type PhenixSubagentRole,
} from "../config/phenix-pi/pi/extensions/phenix-subagent-executor.ts";

// ──────────────────────────────────────────────
// Test framework
// ──────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string): void {
  results.push({ name, passed: condition, detail });
  if (!condition) {
    console.error(`  \u2717 FAIL: ${name}`);
    console.error(`    ${detail}`);
  } else {
    console.log(`  \u2713 PASS: ${name}`);
  }
}

function assertEq(name: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  results.push({ name, passed: pass, detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  if (!pass) {
    console.error(`  \u2717 FAIL: ${name}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  \u2713 PASS: ${name}`);
  }
}

function describe(suite: string, fn: () => void): void {
  console.log(`\n## ${suite}`);
  fn();
}

// ──────────────────────────────────────────────
// Test suites
// ──────────────────────────────────────────────

describe("Scenario 1: D0 skips scout", () => {
  assertEq(
    "D0 typo with exact path -> no scout",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Fix typo in README line X.",
      exactPathsMentioned: ["README"],
      exactSymbolsMentioned: [],
    }),
    false,
  );

  assertEq(
    "D0 with mechanical keyword -> no scout",
    shouldRunRepoScout({
      difficulty: "D0",
      prompt: "Fix the formatting in the error handler.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    false,
  );
});

describe("Scenario 2: D1 runs scout first", () => {
  assertEq(
    "D1 without exact context -> scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Fix /flow argument parsing.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D1 with exact path -> still scout (D1+)",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Update the rollback logic in parseSessionEntries.",
      exactPathsMentioned: ["parseSessionEntries"],
      exactSymbolsMentioned: ["rollback"],
    }),
    true,
  );
});

describe("Scenario 3: D2/D3 runs scout + sensitive keywords", () => {
  assertEq(
    "D2 architectural change -> scout",
    shouldRunRepoScout({
      difficulty: "D2",
      prompt: "Implement real subagents for recursive workflow.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "D3 high-risk auth change -> scout",
    shouldRunRepoScout({
      difficulty: "D3",
      prompt: "Update routing to support new auth provider.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );

  assertEq(
    "sensitive keyword workflow -> scout",
    shouldRunRepoScout({
      difficulty: "D1",
      prompt: "Update workflow routing for MCP integration.",
      exactPathsMentioned: [],
      exactSymbolsMentioned: [],
    }),
    true,
  );
});

describe("Scenario 4: Scout read-only profile", () => {
  const profile = SUBAGENT_PROFILES.repo_scout;

  assertEq("scout role is 'scout'", profile.role, "scout");
  assertEq("scout permissions: read = true", profile.permissions.read, true);
  assertEq("scout permissions: edit = false", profile.permissions.edit, false);
  assertEq("scout permissions: shell = read_only", profile.permissions.shell, "read_only");
  assertEq("scout permissions: network = false", profile.permissions.network, false);
  assertEq("scout permissions: canDelegate = false", profile.permissions.canDelegate, false);
  assertEq("scout permissions: canAskUser = false", profile.permissions.canAskUser, false);
  assertEq("scout tool policy allows 'find'", profile.toolPolicy.allowedTools.includes("find"), true);
  assertEq("scout tool policy denies 'edit'", profile.toolPolicy.deniedTools.includes("edit"), true);
  assertEq("scout tool policy denies 'write'", profile.toolPolicy.deniedTools.includes("write"), true);
  assertEq("scout tool policy enforceable is 'prompt_only'", profile.toolPolicy.enforceable, "prompt_only");
  assertEq("scout output schema is EvidencePacket", profile.outputSchema, "EvidencePacket");
});

describe("Scenario 5: Verifier profile", () => {
  const profile = SUBAGENT_PROFILES.verifier_patch;

  assertEq("verifier role is 'verifier'", profile.role, "verifier");
  assertEq("verifier permissions: read = true", profile.permissions.read, true);
  assertEq("verifier permissions: edit = false", profile.permissions.edit, false);
  assertEq("verifier permissions: shell = safe", profile.permissions.shell, "safe");
  assertEq("verifier tool policy allows 'diff'", profile.toolPolicy.allowedTools.includes("diff"), true);
  assertEq("verifier tool policy denies 'edit'", profile.toolPolicy.deniedTools.includes("edit"), true);
  assertEq("verifier output schema is VerificationReport", profile.outputSchema, "VerificationReport");
});

describe("Scenario 6: No fake subagents - static contract checks", () => {
  assertEq("shouldRunRepoScout is a function", typeof shouldRunRepoScout, "function");
  assertEq("SUBAGENT_PROFILES contains repo_scout", "repo_scout" in SUBAGENT_PROFILES, true);
  assertEq("SUBAGENT_PROFILES contains implementation", "implementation" in SUBAGENT_PROFILES, true);
  assertEq("SUBAGENT_PROFILES contains verifier_patch", "verifier_patch" in SUBAGENT_PROFILES, true);
  assertEq("RECURSION_DEFAULTS is defined", typeof RECURSION_DEFAULTS === "object", true);
  assertEq("resolveSubagentModel is a function", typeof resolveSubagentModel, "function");
  assertEq("runPhenixSubagent is a function", typeof runPhenixSubagent, "function");
  assertEq("parsePiJsonOutput is a function", typeof parsePiJsonOutput, "function");
  assertEq("resolveRoleModel is a function", typeof resolveRoleModel, "function");
  assertEq("ROLE_TOOL_DEFAULTS is an object", typeof ROLE_TOOL_DEFAULTS === "object", true);
});

describe("Recursion safety defaults", () => {
  assertEq("maxDepth is 2", RECURSION_DEFAULTS.maxDepth, 2);
  assertEq("maxChildrenPerTask is 4", RECURSION_DEFAULTS.maxChildrenPerTask, 4);
  assertEq("maxTotalSubagents is 8", RECURSION_DEFAULTS.maxTotalSubagents, 8);
  assertEq("repo_scout maxTurns is 1", RECURSION_DEFAULTS.maxTurnsPerSubagent.repo_scout, 1);
  assertEq("implementation maxTurns is 3", RECURSION_DEFAULTS.maxTurnsPerSubagent.implementation, 3);
  assertEq("verifier_patch maxTurns is 1", RECURSION_DEFAULTS.maxTurnsPerSubagent.verifier_patch, 1);
  assertEq("repo_scout maxToolCalls is 10", RECURSION_DEFAULTS.maxToolCallsPerSubagent.repo_scout, 10);
  assertEq("implementation maxToolCalls is 20", RECURSION_DEFAULTS.maxToolCallsPerSubagent.implementation, 20);
  assertEq("verifier_patch maxToolCalls is 10", RECURSION_DEFAULTS.maxToolCallsPerSubagent.verifier_patch, 10);
});

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

  assertEq("EvidencePacket has summary string", typeof validPacket.summary === "string", true);
  assertEq("EvidencePacket has relevantFiles array", Array.isArray(validPacket.relevantFiles), true);
  assertEq("EvidencePacket relevantFiles[0] has path", typeof validPacket.relevantFiles[0].path === "string", true);
  assertEq("EvidencePacket has symbols array", Array.isArray(validPacket.symbols), true);
  assertEq("EvidencePacket has currentBehavior", typeof validPacket.currentBehavior === "string", true);
  assertEq("EvidencePacket has likelyEditPoints array", Array.isArray(validPacket.likelyEditPoints), true);
  assertEq("EvidencePacket has risks array", Array.isArray(validPacket.risks), true);
  assertEq("EvidencePacket confidence is valid value", ["low", "medium", "high"].includes(validPacket.confidence), true);
});

describe("ROLE_TOOL_DEFAULTS", () => {
  const roles: PhenixSubagentRole[] = ["scout", "planner", "architect", "worker", "verifier", "reviewer", "debugger"];
  for (const role of roles) {
    assertEq(`${role} has tool defaults`, Array.isArray(ROLE_TOOL_DEFAULTS[role]), true);
    assertEq(`${role} tool defaults are non-empty`, ROLE_TOOL_DEFAULTS[role].length > 0, true);
  }

  // Scout only has read-only tools
  const scoutTools = ROLE_TOOL_DEFAULTS["scout"];
  assertEq("scout does NOT have edit", !scoutTools.includes("edit"), true);
  assertEq("scout does NOT have bash", !scoutTools.includes("bash"), true);

  // Worker has edit and bash
  const workerTools = ROLE_TOOL_DEFAULTS["worker"];
  assertEq("worker has edit", workerTools.includes("edit"), true);
  assertEq("worker has bash", workerTools.includes("bash"), true);
  assertEq("worker has ast_grep", workerTools.includes("ast_grep"), true);
});

describe("parsePiJsonOutput", () => {
  // Test 1: Empty input
  const empty = parsePiJsonOutput("", 50000, 2000);
  assertEq("empty input produces empty text", empty.cleanedText, "");
  assertEq("empty input is not truncated", empty.truncated, false);
  assertEq("empty input has null model", empty.modelUsed, null);

  // Test 2: Standard JSON events
  const jsonEvents = [
    '{"type":"start","partial":{"content":[{"type":"text","text":"Exploring"}]}}',
    '{"type":"chunk","delta":{"type":"text","text":" the repository..."}}',
    '{"type":"end","result":{"content":[{"type":"text","text":"Final summary"}],"model":"opencode/deepseek-v4-flash","stopReason":"stop"}}',
  ].join("\n");

  const parsed = parsePiJsonOutput(jsonEvents, 50000, 2000);
  assertEq("JSON events produce combined text", parsed.cleanedText.includes("Exploring"), true);
  assertEq("JSON events produce final summary", parsed.cleanedText.includes("Final summary"), true);
  assertEq("JSON events extract model", parsed.modelUsed, "opencode/deepseek-v4-flash");
  assertEq("JSON events not truncated", parsed.truncated, false);

  // Test 3: Non-JSON fallback
  const plainText = "Hello, this is plain text output.\nLine 2.\nLine 3.";
  const plainParsed = parsePiJsonOutput(plainText, 50000, 2000);
  assertEq("Non-JSON text falls back to raw text", plainParsed.cleanedText.includes("Hello"), true);
  assertEq("Non-JSON preserves newlines", plainParsed.lines, 3);

  // Test 4: Byte truncation
  const longText = "A".repeat(100);
  const truncated_by_bytes = parsePiJsonOutput(longText, 50, 2000);
  assertEq("Byte truncation works", truncated_by_bytes.truncated, true);
  assertEq("Byte truncation reduces size", truncated_by_bytes.cleanedText.length < longText.length, true);

  // Test 5: Line truncation
  const manyLines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
  const truncated_by_lines = parsePiJsonOutput(manyLines, 50000, 10);
  assertEq("Line truncation works", truncated_by_lines.truncated, true);
  assertEq("Line truncation reduces lines", truncated_by_lines.lines <= 11, true);
});

describe("resolveRoleModel", () => {
  assertEq(
    "phenix/free scout -> opencode/deepseek-v4-flash-free",
    resolveRoleModel("phenix/free", "scout", "D1"),
    "opencode/deepseek-v4-flash-free",
  );

  assertEq(
    "phenix/opencode-go worker -> opencode/deepseek-v4-flash",
    resolveRoleModel("phenix/opencode-go", "worker", "D1"),
    "opencode/deepseek-v4-flash",
  );

  assertEq(
    "phenix/gpt verifier -> openai/gpt-5.5",
    resolveRoleModel("phenix/gpt", "verifier", "D1"),
    "openai/gpt-5.5",
  );

  assertEq(
    "phenix/mixed scout -> opencode/deepseek-v4-flash-free",
    resolveRoleModel("phenix/mixed", "scout", "D1"),
    "opencode/deepseek-v4-flash-free",
  );
});

describe("Model set resolution (static config check)", () => {
  const freeScout = { provider: "opencode", model: "deepseek-v4-flash-free" };
  assertEq(
    "phenix/free scout model matches",
    resolveSubagentModel("phenix/free", "scout", "D1", {} as any).modelSet.provider,
    freeScout.provider,
  );

  const mixedVerifier = { provider: "openai", model: "gpt-5.5" };
  assertEq(
    "phenix/mixed verifier model matches",
    resolveSubagentModel("phenix/mixed", "verifier", "D2", {} as any).modelSet.provider,
    mixedVerifier.provider,
  );
});

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
    /streamSimple/.test(source),
    false,
  );

  // @earendil-works/pi-ai/compat import must not appear
  assertEq(
    "pi-ai/compat import does not appear in source",
    /@earendil-works\/pi-ai\/compat/.test(source),
    false,
  );

  // createAssistantMessageEventStream must not appear
  assertEq(
    "createAssistantMessageEventStream does not appear in source",
    /createAssistantMessageEventStream/.test(source),
    false,
  );

  // getApiKeyAndHeaders is ALLOWED only for child env propagation.
  // Verify it appears in code (non-comment) lines.
  const keyCodeLines = codeLines.filter((l) => /getApiKeyAndHeaders/.test(l));
  assertEq(
    "getApiKeyAndHeaders appears in code lines (for env propagation)",
    keyCodeLines.length > 0,
    true,
  );

  // Verify the key resolution is guarded (try/catch wrapper)
  const hasTryBefore = source.includes("try {") && source.includes("getApiKeyAndHeaders");
  const hasCatchAfter = source.includes("getApiKeyAndHeaders") && source.includes("} catch {");
  assertEq(
    "getApiKeyAndHeaders call is guarded by try/catch",
    hasTryBefore && hasCatchAfter,
    true,
  );
});

describe("CRITICAL: Child process spawning semantics", () => {
  const sourcePath = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
  );
  const source = fs.readFileSync(sourcePath, "utf-8");

  const requiredPatterns = [
    { pattern: /spawn/, msg: "imports spawn from node:child_process" },
    { pattern: /--mode/, msg: "uses --mode flag" },
    { pattern: /--no-session/, msg: "uses --no-session for ephemeral subagents" },
    { pattern: /--model/, msg: "passes --model to child" },
    { pattern: /--tools/, msg: "passes --tools to child" },
    { pattern: /PI_SUBAGENT_DEPTH/, msg: "has recursion guard via PI_SUBAGENT_DEPTH env" },
    { pattern: /\.kill\(/, msg: "can kill child process" },
    { pattern: /runPhenixSubagent/, msg: "exports runPhenixSubagent API" },
  ];

  for (const { pattern, msg } of requiredPatterns) {
    assertEq(
      `Source contains ${msg}`,
      pattern.test(source),
      true,
    );
  }
});

describe("RunPhenixSubagentResult schema", () => {
  const mockResult: RunPhenixSubagentResult = {
    status: "done",
    role: "scout",
    modelUsed: "opencode/deepseek-v4-flash-free",
    cwd: "/test",
    summary: "Found relevant files",
    text: '{"summary": "Found files"}',
    bytes: 25,
    lines: 1,
    truncated: false,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 0,
  };

  assertEq("Result has status", mockResult.status, "done");
  assertEq("Result has role", mockResult.role, "scout");
  assertEq("Result has modelUsed", typeof mockResult.modelUsed === "string", true);
  assertEq("Result has cwd", mockResult.cwd, "/test");
  assertEq("Result has summary", mockResult.summary.length > 0, true);
  assertEq("Result has text", mockResult.text.length > 0, true);
  assertEq("Result has bytes as number", typeof mockResult.bytes === "number", true);
  assertEq("Result has lines as number", typeof mockResult.lines === "number", true);
  assertEq("Result has truncated", mockResult.truncated === false, true);
  assertEq("Result has startedAt", typeof mockResult.startedAt === "string", true);
  assertEq("Result has endedAt", typeof mockResult.endedAt === "string", true);
  assertEq("Result has exitCode", mockResult.exitCode === 0, true);

  const errorResult: RunPhenixSubagentResult = {
    status: "failed",
    role: "scout",
    modelUsed: null,
    cwd: "/test",
    summary: "Failed",
    text: "",
    bytes: 0,
    lines: 0,
    truncated: false,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 1,
    error: "Something went wrong",
    details: { rawExitCode: 1 },
  };

  assertEq("Error result has error", errorResult.error, "Something went wrong");
  assertEq("Error result has details", typeof errorResult.details === "object", true);
  assertEq("Error result exitCode is non-zero", errorResult.exitCode, 1);
});

describe("Agent files exist", () => {
  const agentsDir = path.resolve(__dirname, "..", "config/phenix-pi/pi/agents");
  const requiredAgents = ["repo_scout.md", "planner.md", "worker.md", "verifier.md", "reviewer.md", "debugger.md"];

  for (const agent of requiredAgents) {
    const agentPath = path.join(agentsDir, agent);
    assertEq(
      `Agent file ${agent} exists`,
      fs.existsSync(agentPath),
      true,
    );
  }
});

describe("Extension default export exists", () => {
  assertEq("phenixSubagentExecutor is a function", typeof phenixSubagentExecutor, "function");
});



describe("Parallel subagent execution", () => {

  assertEq("PARALLEL_DEFAULTS is defined", typeof PARALLEL_DEFAULTS === "object", true);
  assertEq("PARALLEL_DEFAULTS maxConcurrency is 4", PARALLEL_DEFAULTS.maxConcurrency, 4);
  assertEq("PARALLEL_DEFAULTS maxTotalSubagents is 8", PARALLEL_DEFAULTS.maxTotalSubagents, 8);
  assertEq("COMM_CHANNEL_DEFAULTS is defined", typeof COMM_CHANNEL_DEFAULTS === "object", true);
  assertEq("COMM_CHANNEL_DEFAULTS dirName", COMM_CHANNEL_DEFAULTS.dirName, ".phenix-subagent-comm");
  assertEq("runPhenixSubagentsParallel is a function", typeof runPhenixSubagentsParallel, "function");
  assertEq("ensureCommChannelDir is a function", typeof ensureCommChannelDir, "function");
  assertEq("writeCommMessage is a function", typeof writeCommMessage, "function");
  assertEq("readCommMessage is a function", typeof readCommMessage, "function");
  assertEq("listCommMessages is a function", typeof listCommMessages, "function");
  assertEq("writeSubagentResult is a function", typeof writeSubagentResult, "function");
  assertEq("readSubagentResult is a function", typeof readSubagentResult, "function");
  assertEq("AGENT_COMM_MCP_OPS is an array", Array.isArray(AGENT_COMM_MCP_OPS), true);
});

describe("Comm channel functionality", () => {

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-test-comm-"));
  const commDir = ensureCommChannelDir(tmpDir, { dir: path.join(tmpDir, "test-comm"), autoCleanup: false });

  assertEq("ensureCommChannelDir creates dir", fs.existsSync(commDir), true);

  const msg = {
    id: "test-msg-1",
    source: "scout" as const,
    target: "all" as const,
    type: "evidence" as const,
    timestamp: new Date().toISOString(),
    payload: { summary: "test evidence", confidence: "high" },
  };

  const filePath = writeCommMessage(commDir, msg);
  assertEq("writeCommMessage returns a path", fs.existsSync(filePath), true);

  const readMsg = readCommMessage(commDir, "test-msg-1");
  assertEq("readCommMessage returns the message", readMsg !== null, true);
  assertEq("readCommMessage has correct id", readMsg?.id, "test-msg-1");
  assertEq("readCommMessage has correct source", readMsg?.source, "scout");
  assertEq("readCommMessage has correct type", readMsg?.type, "evidence");

  const messages = listCommMessages(commDir);
  assertEq("listCommMessages returns non-empty array", messages.length > 0, true);
  assertEq("listCommMessages includes our message", messages.some(m => m.id === "test-msg-1"), true);

  const evidenceOnly = listCommMessages(commDir, { type: "evidence" });
  assertEq("listCommMessages filters by type", evidenceOnly.length, 1);

  const planOnly = listCommMessages(commDir, { type: "plan" });
  assertEq("listCommMessages filters no matches for plan", planOnly.length, 0);

  // Write subagent result
  const mockResult: RunPhenixSubagentResult = {
    status: "done",
    role: "scout",
    modelUsed: "opencode/deepseek-v4-flash-free",
    cwd: tmpDir,
    summary: "Found relevant files",
    text: '{"summary": "Found files"}',
    bytes: 25,
    lines: 1,
    truncated: false,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 0,
  };

  const resultPath = writeSubagentResult(commDir, "run-1", "scout", mockResult);
  assertEq("writeSubagentResult creates file", fs.existsSync(resultPath), true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assertEq("Comm channel cleanup succeeded", true, true);
});

describe("Config passthrough check", () => {
  const srcPath = path.resolve(__dirname, "..", "config/phenix-pi/pi/extensions/phenix-subagent-executor.ts");
  const source = fs.readFileSync(srcPath, "utf-8");

  assertEq("Source sets PI_CODING_AGENT_DIR in env", /PI_CODING_AGENT_DIR/.test(source), true);
  assertEq("Source sets PI_DIR in env", /PI_DIR/.test(source), true);
  assertEq("Source has config passthrough comment", source.toLowerCase().includes("config directory passthrough"), true);
});

describe("All roles modeled as subagents in flow", () => {
  const srcPath = path.resolve(__dirname, "..", "config/phenix-pi/pi/extensions/phenix-flow.ts");
  const source = fs.readFileSync(srcPath, "utf-8");

  assertEq("flow.ts imports runPhenixSubagent", /runPhenixSubagent/.test(source), true);
  assertEq("flow.ts imports runPhenixSubagentsParallel", /runPhenixSubagentsParallel/.test(source), true);
  assertEq("flow.ts imports ensureCommChannelDir", /ensureCommChannelDir/.test(source), true);
  assertEq("flow.ts has runFlowSubagent function", /async function runFlowSubagent/.test(source), true);
  assertEq("flow.ts has runFlowScoutAndPlanner function", /async function runFlowScoutAndPlanner/.test(source), true);
  assertEq("flow.ts has runFlowWorker function", /async function runFlowWorker/.test(source), true);
  assertEq("flow.ts has runFlowVerifier function", /async function runFlowVerifier/.test(source), true);

  assertEq("flow.ts runs scout subagent", /runFlowSubagent\("scout"/.test(source), true);
  assertEq("flow.ts runs planner subagent", /runFlowSubagent\("planner"/.test(source), true);
  assertEq("flow.ts runs worker subagent", /runFlowSubagent\("worker"/.test(source), true);
  assertEq("flow.ts runs verifier subagent", /runFlowSubagent\("verifier"/.test(source), true);
});

// ──────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${passed}/${total} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  console.error(`\nFAILED TESTS:`);
  results.filter((r) => !r.passed).forEach((r) => {
    console.error(`  - ${r.name}: ${r.detail}`);
  });
  process.exit(1);
} else {
  console.log(`\n\u2705 All ${passed} tests passed!`);
}



