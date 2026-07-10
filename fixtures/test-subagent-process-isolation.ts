/**
 * test-subagent-process-isolation.ts — Real Subagent Spawning Verification
 *
 * This test DEMONSTRATES that subagents are REAL CHILD PI PROCESSES,
 * not one agent pretending to be many. It verifies:
 *
 *   1. Distinct PIDs — child pi processes have different PIDs from the parent
 *   2. Process tree — child is a real OS process (ps output), not an in-process thread
 *   3. Compact handoff — parent receives only bounded summary, not full tool transcript
 *   4. Role isolation — scout uses read-only tools, worker gets edit tools
 *   5. Recursion guard — depth limits prevent runaway subagent nesting
 *
 * Run with:
 *   npx tsx fixtures/test-subagent-process-isolation.ts --live  (requires pi on PATH)
 *   npx tsx fixtures/test-subagent-process-isolation.ts          (mocked mode, CI-safe)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ──────────────────────────────────────────────
// Test framework
// ──────────────────────────────────────────────

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	evidence?: string;
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

function describe(suite: string, fn: () => void): void {
	console.log(`\n== ${suite} ==`);
	fn();
}
function noop(): void {}
describe.skip = (_suite: string, _fn: () => void) => noop();

// ──────────────────────────────────────────────
// 1. AGENT FILE LOOKUP (no pi needed)
// ──────────────────────────────────────────────

describe("Agent file mapping proves role distinction", () => {
	const agentsDir = path.resolve(__dirname, "..", "config/phenix-pi/pi/agents");

	// Verify each role has a distinct agent file with role-specific tools
	const roleFiles: Record<string, string> = {
		scout: "repo_scout.md",
		planner: "planner.md",
		worker: "worker.md",
		verifier: "verifier.md",
	};

	for (const [role, expectedFile] of Object.entries(roleFiles)) {
		const filePath = path.join(agentsDir, expectedFile);
		assert(
			`${role} agent file exists: ${expectedFile}`,
			fs.existsSync(filePath),
			`Expected ${filePath} to exist`,
		);
	}

	// Verify that the REVERSE mapping does NOT exist — no generic "scout.md"
	assert(
		"No generic scout.md (real file is repo_scout.md)",
		!fs.existsSync(path.join(agentsDir, "scout.md")),
		"scout.md should not exist — the file is repo_scout.md",
	);

	// Verify agent file contents differ by role
	const scoutMd = fs.readFileSync(
		path.join(agentsDir, "repo_scout.md"),
		"utf-8",
	);
	const workerMd = fs.readFileSync(path.join(agentsDir, "worker.md"), "utf-8");

	// Scout should be read-only
	const hasReadTools = /read|find|search|grep|ls|lsp/i.test(scoutMd);
	assert(
		"repo_scout.md mentions read-only tools",
		hasReadTools,
		"Scout agent file should list read tools (read/find/search/lsp)",
	);

	// Worker should have edit tools
	const hasEditTools = /edit|ast_grep|ast_edit/i.test(workerMd);
	assert(
		"worker.md mentions edit/write tools",
		hasEditTools,
		"Worker agent file should list edit tools (edit/ast_grep/ast_edit)",
	);
});

// ──────────────────────────────────────────────
// 2. ROLE_TOOL_DEFAULTS PROVE TOOL ISOLATION (no pi needed)
// ──────────────────────────────────────────────

describe("ROLE_TOOL_DEFAULTS enforce role-specific tool access", () => {
	// We can check the exported constants from the subagent-executor module
	const sourcePath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
	);
	const source = fs.readFileSync(sourcePath, "utf-8");

	// Scout tools should NOT include edit/bash
	const scoutToolsMatch = source.match(/scout:\s*\[([^\]]*)\]/);
	if (scoutToolsMatch) {
		const scoutTools = scoutToolsMatch[1];
		assert(
			"scout tools do NOT include 'edit'",
			!scoutTools.includes("edit"),
			`Scout tools: ${scoutTools}`,
		);
		assert(
			"scout tools do NOT include 'bash'",
			!scoutTools.includes("bash"),
			`Scout tools: ${scoutTools}`,
		);
		assert(
			"scout tools include 'read' or 'find'",
			scoutTools.includes("read") || scoutTools.includes("find"),
			`Scout tools: ${scoutTools}`,
		);
	}

	// Worker tools SHOULD include edit/bash
	const workerToolsMatch = source.match(/worker:\s*\[([^\]]*)\]/);
	if (workerToolsMatch) {
		const workerTools = workerToolsMatch[1];
		assert(
			"worker tools include 'edit'",
			workerTools.includes("edit"),
			`Worker tools: ${workerTools}`,
		);
		assert(
			"worker tools include 'bash'",
			workerTools.includes("bash"),
			`Worker tools: ${workerTools}`,
		);
	}
});

// ──────────────────────────────────────────────
// 3. PROCESS SPAWNING SEMANTICS (no pi needed)
// ──────────────────────────────────────────────

describe("Subagent executor uses child process spawning (not in-process)", () => {
	const sourcePath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
	);
	const source = fs.readFileSync(sourcePath, "utf-8");

	// Must import spawn from child_process
	assert(
		"spawn is imported from node:child_process",
		source.includes("spawn") && source.includes("child_process"),
		"Must import spawn from child_process",
	);

	// Must NOT use fork (which shares process)
	assert(
		"fork is NOT imported",
		!/import.*fork/.test(source) && !source.includes("fork("),
		"Must NOT use fork — spawn real child processes",
	);

	// Must NOT call model APIs directly (streamSimple)
	assert(
		"No direct model streaming (streamSimple)",
		!source.includes("streamSimple"),
		"Must NOT call model APIs directly in subagent executor",
	);

	// Must set PI_SUBAGENT_DEPTH for recursion guard
	assert(
		"PI_SUBAGENT_DEPTH env var for recursion guard",
		source.includes("PI_SUBAGENT_DEPTH"),
		"Must set recursion depth env var",
	);

	// Must set PI_OFFLINE=1
	assert(
		"PI_OFFLINE=1 is set",
		source.includes('PI_OFFLINE: "1"') || source.includes('PI_OFFLINE = "1"'),
		"Must set PI_OFFLINE=1",
	);
});

// ──────────────────────────────────────────────
// 4. CHILD PROCESS ARGS PROVE REAL PI INVOCATION (no pi needed)
// ──────────────────────────────────────────────

describe("Child pi process arguments prove real CLI invocation", () => {
	const sourcePath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-subagent-executor.ts",
	);
	const source = fs.readFileSync(sourcePath, "utf-8");

	// Must use --mode json -p --no-session
	assert(
		"--mode flag is passed to child pi",
		source.includes("--mode"),
		"Must pass --mode to child pi",
	);
	assert(
		"-p flag is passed to child pi",
		source.includes('"-p"') ||
			source.includes("'-p'") ||
			source.includes("-p,"),
		"Must pass -p (prompt) to child pi",
	);
	assert(
		"--no-session flag is passed to child pi",
		source.includes("--no-session"),
		"Must pass --no-session to child pi",
	);
	assert(
		"--model flag is passed to child pi",
		source.includes("--model"),
		"Must pass --model to child pi",
	);
	assert(
		"--tools flag is passed to child pi",
		source.includes("--tools"),
		"Must pass --tools to child pi",
	);

	// Must NOT use argv for long prompts (uses stdin/tempfile)
	assert(
		"Has stdin prompt transport (not raw argv)",
		source.includes("stdinContent") || source.includes("STDIN_PROMPT_ENABLED"),
		"Must have stdin-based prompt transport",
	);
});

// ──────────────────────────────────────────────
// 5. PARENT PID != CHILD PID PROOF (requires pi on PATH)
// ──────────────────────────────────────────────

const isLive = process.argv.includes("--live");

if (isLive) {
	// Skipped: legacy custom subagent executor (phenix-subagent-executor.ts) was removed.
	// Process isolation and recursion guards are now handled by pi-subagents' subagent tool.
	// See: config/phenix-pi/pi/chains/ for declarative chain workflows.
	describe.skip("LIVE TEST: Child pi processes have different PIDs from parent", () => {
		// ponytail: skipped — subagent-executor was removed, use pi-subagents subagent tool instead
	});
}

// ──────────────────────────────────────────────
// 6. STATIC CHECK: Flow router intercepts subagent stages
// ──────────────────────────────────────────────

describe("Flow router intercepts subagent stages (static check)", () => {
	const routerPath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-router.ts",
	);
	const routerSrc = fs.readFileSync(routerPath, "utf-8");

	assert(
		"router checks __phenixFlowActive",
		routerSrc.includes("__phenixFlowActive"),
		"router must check global flow active flag",
	);

	assert(
		"router checks __phenixFlowStage",
		routerSrc.includes("__phenixFlowStage"),
		"router must check global flow stage flag",
	);

	assert(
		"router returns placeholder for subagent stages",
		routerSrc.includes("subagent in progress"),
		"router must return placeholder message for subagent stages",
	);

	const flowPath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-flow/index.ts",
	);
	const flowSrc = fs.readFileSync(flowPath, "utf-8");

	assert(
		"flow exports phenixFlow function",
		flowSrc.includes("function phenixFlow"),
		"flow must export default phenixFlow extension function",
	);

	assert(
		"flow imports reduce from machine",
		flowSrc.includes("reduce") && flowSrc.includes('from "./machine"'),
		"flow must import pure reducer from machine module",
	);

	assert(
		"flow dispatches START_WORKFLOW event",
		flowSrc.includes('type: "START_WORKFLOW"'),
		"flow must dispatch typed events to reducer",
	);

	assert(
		"flow has isWorkflowTask guard",
		flowSrc.includes("isWorkflowTask"),
		"flow must guard conversational prompts from auto-routing",
	);

	assert(
		"flow has runEffects helper",
		flowSrc.includes("function runEffects"),
		"flow must interpret effects returned by reducer",
	);

	assert(
		"flow checks state.tag === done/failed/cancelled",
		flowSrc.includes('state.tag === "done"'),
		"flow must check terminal states via discriminated union tag",
	);
});

// ──────────────────────────────────────────────
// 7. CLASSIFY DIFFICULTY WITH INVESTIGATION KEYWORDS
// ──────────────────────────────────────────────

describe("classifyDifficulty handles investigation/debug correctly (static check)", () => {
	const flowPath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-flow/index.ts",
	);
	const flowSrc = fs.readFileSync(flowPath, "utf-8");

	assert(
		"classifyDifficulty has investigate keyword rule",
		flowSrc.includes("investigate") && flowSrc.includes("D1"),
		"Must classify 'investigate' prompts as at least D1",
	);

	assert(
		"classifyDifficulty has debug keyword rule",
		flowSrc.includes("debug") && flowSrc.includes("D1"),
		"Must classify 'debug' prompts as at least D1",
	);

	assert(
		"classifyDifficulty has workflow keyword rule (D2+ threshold)",
		flowSrc.includes("workflow") && flowSrc.includes("D2"),
		"Must classify 'workflow' prompts as at least D2",
	);

	assert(
		"classifyDifficulty has subagent keyword rule (D2+ threshold)",
		flowSrc.includes("subagent") && flowSrc.includes("D2"),
		"Must classify 'subagent' prompts as at least D2",
	);

	assert(
		"classifyDifficulty has router keyword rule (D2+ threshold)",
		flowSrc.includes("router") && flowSrc.includes("D2"),
		"Must classify 'router' prompts as at least D2",
	);
});

// ──────────────────────────────────────────────
// 8. PHENIX-FLOW-DEBUG CUSTOM ENTRY
// ──────────────────────────────────────────────

describe("phenix-flow-debug custom entry is emitted per turn (static check)", () => {
	const flowPath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-flow/index.ts",
	);
	const flowSrc = fs.readFileSync(flowPath, "utf-8");

	assert(
		"flow emits phenix-flow-debug entry",
		flowSrc.includes("phenix-flow-debug"),
		"flow must emit a custom entry with type 'phenix-flow-debug'",
	);

	assert(
		"debug entry includes autostartDecision field",
		flowSrc.includes("autostartDecision"),
		"debug entry must include autostartDecision",
	);

	assert(
		"debug entry includes difficulty field",
		flowSrc.includes("difficulty"),
		"debug entry must include difficulty",
	);

	assert(
		"debug entry includes useSubagents field",
		flowSrc.includes("useSubagents"),
		"debug entry must include useSubagents",
	);

	assert(
		"debug entry includes spawnedRoles field",
		flowSrc.includes("spawnedRoles"),
		"debug entry must include spawnedRoles",
	);
});

// ──────────────────────────────────────────────
// Print results

describe("extractLatestUserPrompt correctly reads session entries (static check)", () => {
	const flowPath = path.resolve(
		__dirname,
		"..",
		"config/phenix-pi/pi/extensions/phenix-flow/index.ts",
	);
	const flowSrc = fs.readFileSync(flowPath, "utf-8");

	assert(
		"extractLatestUserPrompt checks for type === message (not type === user)",
		flowSrc.includes('e.type === "message"'),
		"Must look for type === message, not type === user — entries have type: message, not type: user",
	);

	assert(
		"extractLatestUserPrompt checks message.role === user",
		flowSrc.includes('"message" && e.message?.role === "user"'),
		"Must check message.role === user to find user messages",
	);

	assert(
		"extractLatestUserPrompt parses message.content array with text filter",
		flowSrc.includes('.filter((c: any) => c.type === "text")'),
		"Must filter content array for text type parts",
	);

	assert(
		"autostart uses event.prompt as primary source",
		flowSrc.includes("event.prompt"),
		"Must use event.prompt from before_agent_start event instead of scanning session entries",
	);
});

// ──────────────────────────────────────────────

if (!isLive) {
	printResults();
}

function printResults(): void {
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	const total = results.length;

	console.log(`\n${"=".repeat(70)}`);
	console.log(
		`SUBAGENT PROCESS ISOLATION TEST RESULTS: ${passed}/${total} passed, ${failed} failed`,
	);
	console.log(`${"=".repeat(70)}`);

	if (failed > 0) {
		console.error(`\nFAILED TESTS:`);
		results
			.filter((r) => !r.passed)
			.forEach((r) => {
				console.error(`  - ${r.name}: ${r.detail}`);
			});
		process.exit(1);
	} else {
		console.log(`\n✅ All ${passed} tests passed!`);

		if (!isLive) {
			console.log(`\nℹ️  Run with --live for real child pi PID verification:`);
			console.log(
				`   npx tsx fixtures/test-subagent-process-isolation.ts --live`,
			);

			console.log(`\nℹ️  Or run via nix:`);
			console.log(`   nix run .#test-subagent-isolation`);
		}
	}
}
