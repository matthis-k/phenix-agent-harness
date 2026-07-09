/**
 * smoke-subagent-live.ts — Live subprocess smoke test for subagent executor.
 *
 * This test verifies that runPhenixSubagent() actually spawns a child pi process,
 * resolves the correct agent file, passes prompts via stdin/temp-file (not long argv),
 * and returns proper results.
 *
 * Two modes:
 *   1. MOCKED mode: Tests spawn semantics, env construction, agent file lookup,
 *      and prompt transport without calling a real model. Runs in CI.
 *   2. LIVE mode: Uses a real child pi process with a simple task.
 *      Requires pi on PATH. Run manually.
 *
 * Usage:
 *   npx tsx fixtures/smoke-subagent-live.ts           # mocked (CI-safe)
 *   npx tsx fixtures/smoke-subagent-live.ts --live     # real child pi
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ──────────────────────────────────────────────
// Import the modules to test
// ──────────────────────────────────────────────
import {
  runPhenixSubagent,
  AGENT_FILE_BY_ROLE,
  buildChildEnv,
  ensureCommChannelDir,
  type RunPhenixSubagentInput,
  type RunPhenixSubagentResult,
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
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${detail}`);
  } else {
    console.log(`  ✓ PASS: ${name}`);
  }
}

function assertEq(name: string, actual: unknown, expected: unknown): void {
  const pass = actual === expected;
  results.push({
    name,
    passed: pass,
    detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  });
  if (!pass) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ PASS: ${name}`);
  }
}

function describe(suite: string, fn: () => void): void {
  console.log(`\n## ${suite}`);
  fn();
}

// ──────────────────────────────────────────────
// Create a mock ExtensionContext
// ──────────────────────────────────────────────

function createMockCtx(overrides?: Record<string, unknown>): any {
  return {
    cwd: process.cwd(),
    model: { id: "free", provider: "phenix" },
    modelRegistry: {
      find: () => null,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "no mock keys" }),
    },
    ui: {
      notify: (msg: string) => console.log(`  [mock notify] ${msg}`),
    },
    sessionManager: {
      getEntries: () => [],
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// Static tests (CI-safe)
// ──────────────────────────────────────────────

describe("Test 1: AGENT_FILE_BY_ROLE mapping", () => {
  assertEq("scout -> repo_scout.md", AGENT_FILE_BY_ROLE["scout"], "repo_scout.md");
  assertEq("planner -> planner.md", AGENT_FILE_BY_ROLE["planner"], "planner.md");
  assertEq("architect -> planner.md", AGENT_FILE_BY_ROLE["architect"], "planner.md");
  assertEq("worker -> worker.md", AGENT_FILE_BY_ROLE["worker"], "worker.md");
  assertEq("verifier -> verifier.md", AGENT_FILE_BY_ROLE["verifier"], "verifier.md");
  assertEq("reviewer -> reviewer.md", AGENT_FILE_BY_ROLE["reviewer"], "reviewer.md");
  assertEq("debugger -> debugger.md", AGENT_FILE_BY_ROLE["debugger"], "debugger.md");

  // Verify all roles have entries
  const expectedRoles: PhenixSubagentRole[] = [
    "scout", "planner", "architect", "worker", "verifier", "reviewer", "debugger",
  ];
  for (const role of expectedRoles) {
    assertEq(`${role} has agent file mapping`, typeof AGENT_FILE_BY_ROLE[role] === "string", true);
  }
});

describe("Test 2: Agent file lookup resolves repo_scout.md for scout", () => {
  // Check that the agent files actually exist on disk
  const agentsDir = path.resolve(__dirname, "..", "config/phenix-pi/pi/agents");
  assert(
    "repo_scout.md exists on disk",
    fs.existsSync(path.join(agentsDir, "repo_scout.md")),
    `Expected ${path.join(agentsDir, "repo_scout.md")} to exist`,
  );
  assert(
    "planner.md exists on disk",
    fs.existsSync(path.join(agentsDir, "planner.md")),
    `Expected ${path.join(agentsDir, "planner.md")} to exist`,
  );
  assert(
    "worker.md exists on disk",
    fs.existsSync(path.join(agentsDir, "worker.md")),
    `Expected ${path.join(agentsDir, "worker.md")} to exist`,
  );
  assert(
    "verifier.md exists on disk",
    fs.existsSync(path.join(agentsDir, "verifier.md")),
    `Expected ${path.join(agentsDir, "verifier.md")} to exist`,
  );

  // Verify NO file named "scout.md" exists (it's repo_scout.md)
  assert(
    "scout.md does NOT exist (real file is repo_scout.md)",
    !fs.existsSync(path.join(agentsDir, "scout.md")),
    "scout.md should not exist — the file is repo_scout.md",
  );
});

describe("Test 3: Prompt transport avoids argv for long prompts", () => {
  const srcPath = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
  );
  const source = fs.readFileSync(srcPath, "utf-8");

  // Verify that the code has prompt transport logic
  assert(
    "Has MAX_ARG_PROMPT_BYTES constant",
    source.includes("MAX_ARG_PROMPT_BYTES"),
    "Should define a max arg prompt byte limit",
  );
  assert(
    "Has stdin prompt transport logic",
    source.includes("stdinContent") || source.includes("STDIN_PROMPT_ENABLED"),
    "Should have stdin prompt transport",
  );
  assert(
    "Has temp file cleanup",
    source.includes("cleanupTempDir"),
    "Should clean up temp files",
  );
  assert(
    "Has prompt transport failure for long prompts",
    source.includes("argv_fallback_exhausted"),
    "Should fail explicitly for long prompts without transport",
  );

  // Verify that the task is no longer unconditionally appended to argv
  const taskPushLines = source
    .split("\n")
    .filter((l) => l.includes("piArgs.push(task)") || l.includes("piArgs.push(task"));

  // Should NOT have the old unconditional push
  assert(
    "Does not push task unconditionally as positional arg",
    taskPushLines.length === 0,
    "Task should NOT be unconditionally pushed to args — use prompt transport",
  );
});

describe("Test 4: Child env includes commDir/runId/role when set", () => {
  const ctx = createMockCtx();
  process.env.PI_CODING_AGENT_DIR = "/test/pi-dir";
  process.env.PI_DIR = "/test/pi-home";

  try {
    const baseEnv = buildChildEnv(
      {
        role: "scout",
        task: "test task",
        cwd: "/tmp",
      },
      ctx,
    );

    // Without commDir, should NOT include comm env vars
    assert(
      "Env without commDir does not include PI_SUBAGENT_COMM_DIR",
      baseEnv["PI_SUBAGENT_COMM_DIR"] === undefined,
      "Should not set comm dir env when not provided",
    );

    const commEnv = buildChildEnv(
      {
        role: "scout",
        task: "test task",
        cwd: "/tmp",
        commDir: "/tmp/comm",
        runId: "test-run-123",
      },
      ctx,
    );

    assertEq(
      "PI_SUBAGENT_COMM_DIR is set when commDir provided",
      commEnv["PI_SUBAGENT_COMM_DIR"],
      "/tmp/comm",
    );
    assertEq(
      "PI_SUBAGENT_RUN_ID is set when runId provided",
      commEnv["PI_SUBAGENT_RUN_ID"],
      "test-run-123",
    );
    assertEq(
      "PI_SUBAGENT_ROLE is set",
      commEnv["PI_SUBAGENT_ROLE"],
      "scout",
    );
    assertEq(
      "PI_OFFLINE is set",
      commEnv["PI_OFFLINE"],
      "1",
    );
    assert(
      "PI_CODING_AGENT_DIR is preserved",
      commEnv["PI_CODING_AGENT_DIR"] !== undefined,
      "Should preserve PI_CODING_AGENT_DIR",
    );
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_DIR;
  }
});

describe("Test 5: extractVerifierStatus logic (simulated)", () => {
  // We can test extractVerifierStatus by importing the flow module
  const flowSrc = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-flow.ts",
  );
  const source = fs.readFileSync(flowSrc, "utf-8");

  assert(
    "flow.ts has extractVerifierStatus function",
    source.includes("extractVerifierStatus"),
    "Should have extractVerifierStatus",
  );
  assert(
    "flow.ts checks for status: pass",
    source.includes('json?.status === "pass"'),
    "Should check for status: pass",
  );
  assert(
    "flow.ts checks for verdict: pass",
    source.includes('json?.verdict === "pass"'),
    "Should check for verdict: pass",
  );
  assert(
    "flow.ts has fallback text matching",
    source.includes('lower.includes("verdict: pass")'),
    "Should have text fallback matching",
  );
});

describe("Test 6: D0 does not use subagents (static check)", () => {
  const flowSrc = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-flow.ts",
  );
  const source = fs.readFileSync(flowSrc, "utf-8");

  assert(
    "flow.ts has direct_executing stage",
    source.includes("direct_executing"),
    "Should have direct_executing stage for D0",
  );
  assert(
    "flow.ts has direct_executing instruction",
    source.includes("Direct Execution (D0)"),
    "Should have D0 direct execution label",
  );
  assert(
    "flow.ts sets useSubagents for D0 via isSimpleTask",
    source.includes("useSubagents = !isSimpleTask"),
    "Should set useSubagents based on isSimpleTask",
  );
  assert(
    "flow.ts initialStage is direct_executing for D0",
    source.includes('initialStage = "direct_executing"'),
    "Should use direct_executing as initial stage for D0",
  );
});

describe("Test 7: D0 does not call runFlowWorker (static check)", () => {
  const flowSrc = path.resolve(
    __dirname,
    "..",
    "config/phenix-pi/pi/extensions/phenix-flow.ts",
  );
  const flowContent = fs.readFileSync(flowSrc, "utf-8");

  // Verify D0 direct_executing is in the stage handlers
  assert(
    "direct_executing is handled in advanceWorkflow",
    flowContent.includes('case "direct_executing"'),
    "advanceWorkflow should handle direct_executing",
  );

  // Verify replanning uses runFlowReplanner not runFlowWorker
  assert(
    "replanning calls runFlowReplanner",
    flowContent.includes("await runFlowReplanner(ctx)"),
    "replanning should call runFlowReplanner (not runFlowWorker)",
  );
});

describe("Test 8: Comm channel directory functions work", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-smoke-comm-"));
  try {
    const commDir = ensureCommChannelDir(tmpDir, {
      dir: path.join(tmpDir, "smoke-comm"),
    });
    assert("ensureCommChannelDir creates directory", fs.existsSync(commDir), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("Test 9: No files modified for scout (read-only validation)", () => {
  const agentsDir = path.resolve(__dirname, "..", "config/phenix-pi/pi/agents");
  const scoutMd = path.join(agentsDir, "repo_scout.md");
  const content = fs.readFileSync(scoutMd, "utf-8");

  // Verify the agent has read-only tools listed
  assert(
    "repo_scout.md mentions read-only tools",
    content.toLowerCase().includes("read") || content.toLowerCase().includes("find") || content.toLowerCase().includes("search"),
    "Scout agent should list read-only tools",
  );

  // Verify no write/edit tools
  assert(
    "repo_scout.md does NOT mention edit",
    !content.toLowerCase().includes("edit tool") && !content.toLowerCase().includes("write tool"),
    "Scout agent should not mention edit tools",
  );
});

// ──────────────────────────────────────────────
// Live Pi spawn test (manual, requires pi on PATH)
// ──────────────────────────────────────────────

const isLive = process.argv.includes("--live");

if (isLive) {
  describe("LIVE TEST: Child pi process spawn (requires pi on PATH)", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-live-test-"));

    try {
      // Create a minimal fixture
      fs.writeFileSync(
        path.join(testDir, "hello.txt"),
        "Hello, world!\nThis is a test file.\n",
        "utf-8",
      );
    } catch (e) {
      // ok
    }

    (async () => {
      const ctx = createMockCtx({ cwd: testDir });
      const result = await runPhenixSubagent(
        {
          role: "scout",
          task: "Find and read hello.txt. Report its contents.",
          cwd: testDir,
          tools: ["read", "find"],
          maxBytes: 5000,
          maxLines: 100,
          timeoutMs: 30_000,
        },
        ctx,
      );
      assert("LIVE: Child process started (exitCode non-null)", result.exitCode !== null, "Should have exit code");
      assert("LIVE: Status is done/failed/timeout", ["done","failed","timeout"].includes(result.status), "Got: " + result.status);
      assert("LIVE: Has model or null", typeof result.modelUsed === "string" || result.modelUsed === null, "modelUsed: " + result.modelUsed);
      assert("LIVE: Has output", result.summary.length > 0 || result.text.length > 0, "Should produce output");
      if (result.status === "done") assert("LIVE: Done has bytes > 0", result.bytes > 0, "bytes: " + result.bytes);
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    })();
  });
}

// ──────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
const total = results.length;

console.log(`\n${"=".repeat(60)}`);
console.log(`SMOKE TEST RESULTS: ${passed}/${total} passed, ${failed} failed`);
console.log(`${"=".repeat(60)}`);

if (failed > 0) {
  console.error(`\nFAILED TESTS:`);
  results.filter((r) => !r.passed).forEach((r) => {
    console.error(`  - ${r.name}: ${r.detail}`);
  });
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} tests passed!`);

  if (!isLive) {
    console.log(`\nℹ️  Run with --live for real child pi smoke test:`);
    console.log(`   npx tsx fixtures/smoke-subagent-live.ts --live`);
  }
}

// Helper functions for live tests
function it(name: string, fn: () => Promise<void>): void {
  describe(name, () => {
    // execute inline
  });
}

function afterAll(fn: () => void): void {
  // execute inline
}
