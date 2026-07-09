/**
 * phenix-flow.ts — Multi-Agent Workflow Orchestrator with Real Subagent Execution
 *
 * Registers the `/flow` command and manages a Plan → Execute → Verify → Replan
 * workflow state machine. Each D1+ stage (except classifying and synthesizing)
 * runs as a child Pi subprocess.
 *
 * Stages:
 *   classifying → [scouting] → planning → executing → verifying → synthesizing → done
 *   verifying (fail) → replanning → executing (revised) → verifying ...
 *
 * D0 difficulty: parent direct execution, no child subagent spawned.
 * D1+: scout, planner, worker, verifier run as child Pi subprocesses.
 * Classifying and synthesizing remain parent agent turns.
 *
 * Terminology:
 *   TaskNode / TaskRecord = state/metadata record
 *   SubagentRun          = actual child agent model execution (via SubagentExecutor)
 *   scouting             = real subagent run for evidence gathering
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type PlanContract,
  type PlannerInteractionMode,
} from "./phenix-runtime";
import {
  shouldRunRepoScout,
  runPhenixSubagent,
  detectFrontendModelSet,
  resolveRoleModel,
  ensureCommChannelDir,
  writeCommMessage,
  writeSubagentResult,
  type RunPhenixSubagentResult,
  type PhenixSubagentRole,
  ROLE_TOOL_DEFAULTS,
  type EvidencePacket as ExecEvidencePacket,
} from "./phenix-subagent-executor";

type FlowStage =
  | "idle"
  | "classifying"
  | "scouting"        // real repo_scout subagent run
  | "planning"
  | "executing"
  | "verifying"
  | "replanning"
  | "synthesizing"
  | "done"
  | "failed"
  | "direct_executing"; // D0: parent direct execution (no child subagent)

type Difficulty = "D0" | "D1" | "D2" | "D3";

interface FlowWorkflow {
  stage: FlowStage;
  originalPrompt: string;
  difficulty: Difficulty | null;
  secrecy: string | null;
  changeKind: string | null;
  plan: string | null;
  planContract: PlanContract | null;
  plannerInteractionMode: PlannerInteractionMode;
  executionResults: string[];
  verificationResult: string | null;
  loopCount: number;
  maxLoops: number;
  rootTaskId: string | null;
  sessionId: string | null;
  graphId: string | null;
  /** Scout evidence packet stored after scouting stage */
  scoutEvidence: ExecEvidencePacket | null;
  /** Status tracking for the scout subagent run */
  scoutResult: RunPhenixSubagentResult | null;
  /** Whether we ran a real subagent scout (vs skipped) */
  ranRealSubagentScout: boolean;
  /** Unique run ID for this flow invocation */
  runId: string;
  /** Comm channel directory for inter-subagent communication */
  commDir: string | null;
  /** Worker/planner/verifier subagent results */
  subagentResults: Record<string, RunPhenixSubagentResult>;
  /** Whether to use child subagents (D0 = false, D1+ = true) */
  useSubagents: boolean;
  /** Verifier parse failure, if any */
  verifierParseFailure: string | null;
}

interface FlowState {
  active: boolean;
  workflow: FlowWorkflow;
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const FLOW_CUSTOM_TYPE = "phenix-flow-state";

const DEFAULT_WORKFLOW: FlowWorkflow = {
  stage: "idle",
  originalPrompt: "",
  difficulty: null,
  secrecy: null,
  changeKind: null,
  plan: null,
  planContract: null,
  plannerInteractionMode: "ask_if_unclear",
  executionResults: [],
  verificationResult: null,
  loopCount: 0,
  maxLoops: 3,
  rootTaskId: null,
  sessionId: null,
  graphId: null,
  scoutEvidence: null,
  runId: "",
  commDir: null,
  subagentResults: {},
  scoutResult: null,
  ranRealSubagentScout: false,
  useSubagents: true,
  verifierParseFailure: null,
};

const DEFAULT_STATE: FlowState = {
  active: false,
  workflow: { ...DEFAULT_WORKFLOW },
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function classifyDifficulty(prompt: string): Difficulty {
  const lower = prompt.toLowerCase();
  if (
    lower.includes("d0") ||
    /\b(typo|format|rename|trivial|obvious|mechanical)\b/i.test(lower)
  )
    return "D0";
  if (
    lower.includes("d3") ||
    /\b(high.risk|ambiguous|security|secret|main.bound|release|cross.repo)\b/i.test(
      lower,
    )
  )
    return "D3";
  if (
    lower.includes("d2") ||
    /\b(architect|multi.file|cross.module|complex|refactor|restructur|redesign)\b/i.test(
      lower,
    )
  )
    return "D2";
  return "D1";
}

/**
 * D0 tasks are trivial/mechanical — parent direct execution, no child subagent.
 * D1+ tasks use the full subagent workflow.
 */
function isSimpleTask(difficulty: Difficulty): boolean {
  return difficulty === "D0";
}

function stageEmoji(stage: FlowStage): string {
  const map: Record<FlowStage, string> = {
    idle: "⏸️",
    classifying: "🔍",
    scouting: "🔎",
    planning: "📋",
    executing: "🔧",
    verifying: "✅",
    replanning: "🔄",
    synthesizing: "📊",
    done: "🎯",
    failed: "❌",
    direct_executing: "🔧",
  };
  return map[stage] ?? "❓";
}

function stageLabel(stage: FlowStage): string {
  const map: Record<FlowStage, string> = {
    idle: "Idle",
    classifying: "Classification",
    scouting: "Repo Scouting",
    planning: "Planning",
    executing: "Execution",
    verifying: "Verification",
    replanning: "Revision",
    synthesizing: "Synthesis",
    done: "Complete",
    failed: "Failed",
    direct_executing: "Direct Execution (D0)",
  };
  return map[stage] ?? stage;
}

// ──────────────────────────────────────────────
// Stage role instructions (injected into system prompt)
// ──────────────────────────────────────────────

function getStageInstruction(stage: FlowStage, _wf: FlowWorkflow): string | null {
  switch (stage) {
    case "classifying":
      return [
        "",
        "## \ud83c\udff7\ufe0f Flow Stage: Task Classification",
        "",
        "Analyze the user\u2019s request and classify it by:",
        "- **Difficulty**: D0 (trivial/mechanical), D1 (bounded repo-aware), D2 (architectural/multi-file), D3 (high-risk/ambiguous)",
        "- **Secrecy**: public, private, or secret",
        "- **Change kind**: code, config, docs, workflow, nix, rust, tests, ci, or other",
        "",
        'End your response with a JSON classification block:\n\`\`\`json\n{"difficulty": "D0|D1|D2|D3", "secrecy": "public|private|secret", "change_kind": "...", "reasoning": "..."}\n\`\`\`',
      ].join("\n");

    case "direct_executing":
      return [
        "",
        "## \ud83d\udd27 Flow Stage: Direct Execution (D0)",
        "",
        "This is a D0 (trivial/mechanical) task. Execute it directly using available tools.",
        "Do NOT run any subagents or multi-stage workflow.",
        "",
        "Complete the task and summarize what was done.",
      ].join("\n");

    case "synthesizing":
      return [
        "",
        "## \ud83d\udcca Flow Stage: Synthesis",
        "",
        "You are the **Orchestrator**. Compile a final summary of:",
        "- What was accomplished",
        "- Changes made (files modified, commands run)",
        "- Verification outcome",
        "- Any remaining notes or follow-up items",
      ].join("\n");

    default:
      // scouting, planning, executing, verifying, replanning are handled as real subagent processes
      return null;
  }
}

function getStageContext(stage: FlowStage, wf: FlowWorkflow): string {
  const header = `**${stageEmoji(stage)} Flow Stage: ${stageLabel(stage)}**\n\n`;

  switch (stage) {
    case "classifying":
      return `${header}Classifying the following request:\n\n${wf.originalPrompt}`;

    case "scouting":
      return (
        `${header}Running real repo_scout subagent for:\n\n${wf.originalPrompt}` +
        (wf.difficulty ? `\n\n*Classified as ${wf.difficulty}, ${wf.secrecy ?? "?"}, ${wf.changeKind ?? "?"}*` : "")
      );

    case "planning": {
      let scoutSection = "";
      if (wf.scoutEvidence) {
        const e = wf.scoutEvidence;
        scoutSection = `\n\n## Repo Scout Evidence\n\n**Summary:** ${e.summary}\n**Confidence:** ${e.confidence}\n**Relevant files:** ${(e.relevantFiles || []).map((f: any) => f.path).join(", ")}\n**Likely edit points:** ${(e.likelyEditPoints || []).map((p: any) => p.path).join(", ")}\n**Risks:** ${(e.risks || []).join(", ")}`;
      }
      if (wf.scoutResult && wf.scoutResult.status !== "done") {
        scoutSection = `\n\n**Scout status:** ${wf.scoutResult.status} — ${wf.scoutResult.summary}`;
      }
      return (
        `${header}Creating a plan for:\n\n${wf.originalPrompt}` +
        (wf.difficulty ? `\n\n*Classified as ${wf.difficulty}, ${wf.secrecy ?? "?"}, ${wf.changeKind ?? "?"}*` : "") +
        scoutSection
      );
    }

    case "executing":
      return (
        `${header}Executing the plan:\n\n` +
        (wf.plan ?? "*No plan available*") +
        `\n\n---\n**Original request:** ${wf.originalPrompt}`
      );

    case "verifying":
      return (
        `${header}Verifying the completed work against the plan.` +
        `\n\n**Original request:** ${wf.originalPrompt}` +
        `\n\n**Plan:**\n${wf.plan ?? "N/A"}` +
        `\n\n**Results:**\n${wf.executionResults.join("\n---\n") || "No results recorded"}`
      );

    case "replanning":
      return (
        `${header}Verification found issues. Revising the plan.` +
        `\n\n**Original request:** ${wf.originalPrompt}` +
        `\n\n**Previous plan:**\n${wf.plan ?? "N/A"}` +
        `\n\n**Verification feedback:**\n${wf.verificationResult ?? "N/A"}`
      );

    case "synthesizing":
      return (
        `${header}Compiling final summary.\n\n` +
        `**Original request:** ${wf.originalPrompt}` +
        `\n\n**Plan:**\n${wf.plan ?? "N/A"}` +
        `\n\n**Results:**\n${wf.executionResults.join("\n---\n") || "No results"}` +
        `\n\n**Verification:**\n${wf.verificationResult ?? "N/A"}`
      );

    case "direct_executing":
      return `${header}Executing directly (D0 trivial task):\n\n${wf.originalPrompt}`;

    default:
      return `${header}${wf.originalPrompt}`;
  }
}

// ──────────────────────────────────────────────
// JSON extraction from assistant response
// ──────────────────────────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  // Try ```json ... ``` block first
  const blockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  // Try standalone { ... } object
  const objectMatch = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Extract verifier status from subagent output.
 *
 * Supports:
 *   - Fenced JSON: ```json { "status": "pass"|"fail" } ```
 *   - Fenced JSON: ```json { "verdict": "pass"|"fail" } ```
 *   - Raw JSON: { "status": "pass"|"fail" }
 *   - Text patterns: "Verdict: pass", "Status: pass", etc.
 */
function extractVerifierStatus(text: string): "pass" | "fail" | "unknown" {
  const json = extractJson(text);
  if (json?.status === "pass" || json?.verdict === "pass") return "pass";
  if (json?.status === "fail" || json?.verdict === "fail") return "fail";

  const lower = text.toLowerCase();
  if (lower.includes("verdict: pass") || lower.includes("status: pass")) return "pass";
  if (lower.includes("verdict: fail") || lower.includes("status: fail")) return "fail";

  return "unknown";
}

function extractVerdict(text: string): string | null {
  const json = extractJson(text);
  if (json && typeof json.verdict === "string") return json.verdict;
  // Heuristic: look for pass/fail keywords
  const lower = text.toLowerCase();
  if (lower.includes("verdict: pass") || /\bverdict["']?\s*:\s*"pass"\b/.test(lower))
    return "pass";
  if (lower.includes("verdict: fail") || /\bverdict["']?\s*:\s*"fail"\b/.test(lower))
    return "fail";
  return null;
}

function extractPlan(text: string): string | null {
  const json = extractJson(text);
  if (json && json.subtasks) {
    return text; // Return the full text — it contains the plan
  }
  // If no JSON, the whole response is the plan
  return text.trim() || null;
}

// ──────────────────────────────────────────────
// State management
// ──────────────────────────────────────────────

let state: FlowState = { ...DEFAULT_STATE };
let piRef: ExtensionAPI | undefined;

function persistState(): void {
  if (!piRef) return;
  try {
    piRef.appendEntry(FLOW_CUSTOM_TYPE, state);
  } catch {
    // best-effort
  }
}

function loadState(ctx: ExtensionContext): void {
  if (!ctx.sessionManager) return;
  try {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === FLOW_CUSTOM_TYPE && entry.data) {
        const loaded = entry.data as FlowState;
        if (loaded.active) {
          state = loaded;
        }
      }
    }
  } catch {
    // quiet
  }
}

// ──────────────────────────────────────────────
// Subagent execution
// ──────────────────────────────────────────────

/**
 * Execute a subagent as a child Pi process.
 * Passes commDir and runId from the workflow state when available.
 */
async function runFlowSubagent(
  role: PhenixSubagentRole,
  task: string,
  ctx: ExtensionContext,
): Promise<RunPhenixSubagentResult> {
  const wf = state.workflow;
  const frontendModel = detectFrontendModelSet(ctx);
  const modelStr = resolveRoleModel(frontendModel, role, (wf.difficulty ?? "D1") as any);
  const tools = ROLE_TOOL_DEFAULTS[role];

  ctx.ui.notify(
    `${stageEmoji(wf.stage)} Running ${role} subagent (model: ${modelStr}, tools: ${tools.join(",")})`,
    "info",
  );

  const result = await runPhenixSubagent(
    {
      role,
      task,
      cwd: ctx.cwd,
      model: modelStr,
      tools,
      maxBytes: 50 * 1024,
      maxLines: 2000,
      timeoutMs: 120_000,
      commDir: wf.commDir,
      runId: wf.runId,
    },
    ctx,
  );

  // Write to comm channel
  if (wf.commDir) {
    writeSubagentResult(wf.commDir, wf.runId, role, result);
    writeCommMessage(wf.commDir, {
      id: `${role}-${Date.now()}`,
      source: role,
      target: "orchestrator",
      type: result.status === "done" ? "status" : "error",
      timestamp: result.endedAt,
      payload: {
        role,
        status: result.status,
        summary: result.summary.slice(0, 200),
        truncated: result.truncated,
        bytes: result.bytes,
        lines: result.lines,
      },
    });
  }

  // Store result
  wf.subagentResults[role] = result;

  if (result.status === "done") {
    ctx.ui.notify(
      `${stageEmoji(wf.stage)} ${role} subagent complete: ${result.summary.slice(0, 100)}`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `\u26a0\ufe0f ${role} subagent ${result.status}: ${(result.error ?? result.summary).slice(0, 200)}`,
      "warning",
    );
  }

  return result;
}

async function runFlowScoutAndPlanner(ctx: ExtensionContext): Promise<void> {
  const wf = state.workflow;
  if (!piRef) return;

  // Stage 1: Scout — gather repo evidence
  await runFlowSubagent("scout",
    `Scout the repository to find context for:\n\n${wf.originalPrompt}\n\nProduce a compact EvidencePacket with relevant files, symbols, edit points, and risks.`,
    ctx);

  const scoutResult = wf.subagentResults["scout"];

  // Extract evidence for planner context
  const evidenceSummary = scoutResult?.text?.slice(0, 3000) ?? "(no scout output)";

  // Stage 2: Planner — produce plan using scout evidence
  const planTask = `## Task\n${wf.originalPrompt}\n\n## Repo Scout Evidence\n${evidenceSummary}\n\n## Your role\nYou are the Planner/Architect.\n- Analyze the task and decompose it into ordered, actionable subtasks\n- Use the scout evidence above \u2014 do NOT re-explore the repository\n- State clear assumptions and success criteria\n- Design the overall approach \u2014 do NOT execute subtasks or modify files\n\nOutput a PlanContract JSON:\n\`\`\`json\n{"goal": "...", "subtasks": [{"id":"task_1","title":"...","role":"worker","profile":"implementation","objective":"...","success_criteria":["..."],"dependencies":[]}], "decisions": ["..."], "acceptance_criteria": ["..."], "non_goals": ["..."], "invariants": ["..."], "interaction_status": "ready"}\n\`\`\``;

  await runFlowSubagent("planner", planTask, ctx);

  // Extract plan from planner result
  const plannerResult = wf.subagentResults["planner"];
  wf.plan = plannerResult?.text ?? wf.plan;

  // Mark that we ran real subagents
  if (scoutResult?.status === "done") {
    wf.ranRealSubagentScout = true;
    try {
      const packet = JSON.parse(scoutResult.text);
      wf.scoutEvidence = packet as ExecEvidencePacket;
    } catch {
      // Plain text evidence
    }
  }
}

async function runFlowWorker(ctx: ExtensionContext): Promise<void> {
  const wf = state.workflow;
  const planForWorker = wf.plan ?? "(no plan)";
  const workerTask = `## Task\n${wf.originalPrompt}\n\n## Plan\n${planForWorker.slice(0, 5000)}\n\n## Your role\nYou are the Developer/Worker.\n- Implement the subtasks from the plan using available tools\n- Edit files, run shell commands, use Git freely\n- Complete ALL subtasks before finishing\n- Summarize what was done and any noteworthy results`;

  await runFlowSubagent("worker", workerTask, ctx);
}

async function runFlowVerifier(ctx: ExtensionContext): Promise<void> {
  const wf = state.workflow;
  const workerResult = wf.subagentResults["worker"];
  const verifierTask = `## Task\n${wf.originalPrompt}\n\n## Plan\n${(wf.plan ?? "(no plan)").slice(0, 3000)}\n\n## Implementation Results\n${(workerResult?.text ?? "(no worker output)").slice(0, 5000)}\n\n## Your role\nYou are the Verifier/Critic.\n- Inspect the completed work against the plan\n- Are all subtasks complete? Are there errors or policy violations?\n- Do the success criteria pass?\n- Run checks (build, lint, test) to verify correctness\n\nOutput a VerificationReport JSON:\n\`\`\`json\n{"status": "pass"|"fail", "failures": [{"issue":"...","evidence":"...","ownerHint":null,"requiredFix":"..."}], "checks": [{"command":"...","result":"pass"|"fail"|"not_run"}], "scopeViolations": []}\n\`\`\``;

  await runFlowSubagent("verifier", verifierTask, ctx);
}

/**
 * Replanning subagent: revises the plan using verifier feedback.
 * This is the preferred approach — a dedicated planner revision step
 * that uses the verifier's failure report to revise the plan,
 * rather than blindly re-executing the same plan.
 */
async function runFlowReplanner(ctx: ExtensionContext): Promise<void> {
  const wf = state.workflow;
  const replannerTask = [
    `## Task`,
    wf.originalPrompt,
    ``,
    `## Previous Plan`,
    (wf.plan ?? "(no plan)").slice(0, 3000),
    ``,
    `## Worker Result`,
    (wf.subagentResults["worker"]?.text ?? "(no worker result)").slice(0, 3000),
    ``,
    `## Verification Failure Report`,
    (wf.verificationResult ?? "(no verification result)").slice(0, 3000),
    ``,
    `## Your role`,
    `You are the Planner/Architect — revising a plan that failed verification.`,
    `- Review the verification failure report above`,
    `- Identify what needs to be fixed in the plan`,
    `- Produce a REVISED plan that addresses each failure`,
    `- Keep what worked, revise only what failed`,
    `- Do NOT re-explore the repository`,
    ``,
    `Output a revised PlanContract JSON:`,
    '```json',
    `{"goal": "...", "subtasks": [...], "decisions": ["Fixed: ..."], "revisions": ["Fixed: ..."], "acceptance_criteria": [...], "non_goals": [...], "invariants": [...], "interaction_status": "ready"}`,
    '```',
  ].join("\n");

  await runFlowSubagent("planner", replannerTask, ctx);

  // Update the plan with the revised version
  const plannerResult = wf.subagentResults["planner"];
  wf.plan = plannerResult?.text ?? wf.plan;
}

// ──────────────────────────────────────────────
// Stage transitions
// ──────────────────────────────────────────────

function nextStageAfterClassify(difficulty: Difficulty): FlowStage {
  if (isSimpleTask(difficulty)) {
    // D0: parent direct execution — no child subagent
    return "direct_executing";
  }
  // D1+: scouting first, then planning
  return "scouting";
}

function nextStage(stage: FlowStage, verdict?: string): FlowStage {
  switch (stage) {
    case "classifying":
      return "planning";
    case "direct_executing":
      return "synthesizing";
    case "scouting":
      return "planning";
    case "planning":
      return "executing";
    case "executing":
      return "verifying";
    case "verifying":
      return verdict === "pass" ? "synthesizing" : "replanning";
    case "replanning":
      return "executing";
    case "synthesizing":
      return "done";
    case "done":
    case "failed":
      return "idle";
    default:
      return "done";
  }
}

function advanceWorkflow(assistantText: string): void {
  const wf = state.workflow;
  wf.loopCount++;

  // Capture data from assistant response based on current stage
  switch (wf.stage) {
    case "classifying": {
      const json = extractJson(assistantText);
      if (json) {
        wf.difficulty = (json.difficulty as Difficulty) ?? classifyDifficulty(wf.originalPrompt);
        wf.secrecy = (json.secrecy as string) ?? "public";
        wf.changeKind = (json.change_kind as string) ?? "unknown";
      } else {
        wf.difficulty = classifyDifficulty(wf.originalPrompt);
        wf.secrecy = "public";
        wf.changeKind = "unknown";
      }
      break;
    }

    case "direct_executing": {
      wf.executionResults.push(assistantText);
      break;
    }

    case "scouting": {
      // Scouting is handled by the SubagentExecutor.
      break;
    }

    case "planning": {
      wf.plan = extractPlan(assistantText) ?? assistantText;
      break;
    }

    case "executing": {
      wf.executionResults.push(assistantText);
      break;
    }

    case "verifying": {
      wf.verificationResult = assistantText;
      break;
    }

    case "replanning": {
      wf.plan = extractPlan(assistantText) ?? assistantText;
      break;
    }

    case "synthesizing": {
      // Final stage — result captured
      break;
    }
  }

  // Determine next stage
  const verdict = wf.stage === "verifying" ? extractVerifierStatus(assistantText) : undefined;

  // If verifier returned unknown, store the failure and fall through to "fail"
  if (wf.stage === "verifying" && verdict === "unknown") {
    wf.verifierParseFailure = "Verifier returned unrecognized status (expected 'pass' or 'fail')";
  }

  // Check loop limits for replanning cycles
  if (
    wf.stage === "verifying" &&
    (verdict === "fail" || verdict === "unknown") &&
    wf.loopCount >= wf.maxLoops
  ) {
    wf.stage = "failed";
    state.active = false;
    (globalThis as any).__phenixFlowActive = false;
    persistState();
    return;
  }

  // Handle transition from classifying based on difficulty
  if (wf.stage === "classifying") {
    const next = nextStageAfterClassify(wf.difficulty ?? "D1");
    wf.stage = next;
    wf.useSubagents = !isSimpleTask(wf.difficulty ?? "D1");
    persistState();
    return;
  }

  // D0 from direct_executing -> synthesizing
  if (wf.stage === "direct_executing") {
    wf.stage = "synthesizing";
    persistState();
    return;
  }

  const next = nextStage(wf.stage, verdict ?? undefined);

  if (next === "done" || next === "idle") {
    wf.stage = next;
    state.active = false;
    (globalThis as any).__phenixFlowActive = false;
    persistState();
    return;
  }

  wf.stage = next;
  persistState();
}

// ──────────────────────────────────────────────
// Trigger next stage via user message
// ──────────────────────────────────────────────

function triggerNextStage(ctx: ExtensionContext): void {
  const wf = state.workflow;
  const context = getStageContext(wf.stage, wf);
  const instruction = getStageInstruction(wf.stage, wf);

  const content = instruction
    ? `${context}\n\n---\n${instruction}`
    : context;

  // Fire-and-forget: Pi queues the message, errors are silently caught
  if (piRef) {
    try {
      piRef.sendUserMessage(content);
    } catch {
      // fallback -- flow will stop at current stage
    }
  }
}

// ──────────────────────────────────────────────
// Register the extension
// ──────────────────────────────────────────────

export default function phenixFlow(pi: ExtensionAPI) {
  piRef = pi;

  // ── Session lifecycle ──

  pi.on("session_start", (_event, ctx) => {
    loadState(ctx);
  });

  // ── before_agent_start: inject role instructions for active workflow ──

  pi.on("before_agent_start", (event, ctx) => {
    if (!state.active || state.workflow.stage === "idle" || state.workflow.stage === "done" || state.workflow.stage === "failed") {
      return;
    }

    const wf = state.workflow;

    // Stages that run as real subagent pi processes (skip the normal agent turn)
    if (wf.stage === "scouting") {
      void (async () => {
        try {
          await runFlowScoutAndPlanner(ctx);
        } catch (err) {
          ctx.ui.notify(
            `\u26a0\ufe0f Scout+Planner execution error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }

        // After scout+planner, advance to executing
        wf.stage = "executing";
        persistState();

        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Advancing to: ${stageLabel(wf.stage)} (loop ${wf.loopCount}/${wf.maxLoops})`,
          "info",
        );
        triggerNextStage(ctx);
      })();

      return {
        systemPrompt: event.systemPrompt,
        message: {
          customType: "phenix-flow-stage",
          content: `\ud83d\udd0e **Scout + Planner subagents running** \u2014 will transition to executing automatically`,
          display: true,
          details: {
            stage: "scouting",
            real_subagent: true,
            subagent_roles: ["scout", "planner"],
            model_set: detectFrontendModelSet(ctx),
          },
        },
      };
    }

    if (wf.stage === "executing") {
      void (async () => {
        try {
          await runFlowWorker(ctx);
        } catch (err) {
          ctx.ui.notify(
            `\u26a0\ufe0f Worker execution error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }

        wf.stage = "verifying";
        persistState();

        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Advancing to: ${stageLabel(wf.stage)} (loop ${wf.loopCount}/${wf.maxLoops})`,
          "info",
        );
        triggerNextStage(ctx);
      })();

      return {
        systemPrompt: event.systemPrompt,
        message: {
          customType: "phenix-flow-stage",
          content: `\ud83d\udd27 **Worker subagent running** \u2014 will transition to verifying automatically`,
          display: true,
          details: {
            stage: "executing",
            real_subagent: true,
            subagent_role: "worker",
            model_set: detectFrontendModelSet(ctx),
          },
        },
      };
    }

    if (wf.stage === "verifying") {
      void (async () => {
        try {
          await runFlowVerifier(ctx);
        } catch (err) {
          ctx.ui.notify(
            `\u26a0\ufe0f Verifier execution error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }

        const verifierResult = wf.subagentResults["verifier"];
        const verdict = extractVerifierStatus(verifierResult?.text ?? "{}");

        // Store parse failure if unknown
        if (verdict === "unknown") {
          wf.verifierParseFailure = "Verifier returned unrecognized status. Expected 'pass' or 'fail' in status/verdict field.";
          ctx.ui.notify(
            `\u26a0\ufe0f Verifier status unrecognized — marking as fail for safety. Raw text: ${(verifierResult?.text ?? "").slice(0, 200)}`,
            "warning",
          );
        }

        const resolvedVerdict = verdict === "pass" ? "pass" : "fail";

        if (resolvedVerdict === "pass") {
          wf.stage = "synthesizing";
        } else {
          // Use replanning subagent (with verifier feedback) instead of blindly re-executing
          wf.stage = "replanning";
        }
        persistState();

        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Verdict: ${resolvedVerdict} \u2014 advancing to: ${stageLabel(wf.stage)} (loop ${wf.loopCount}/${wf.maxLoops})`,
          "info",
        );
        triggerNextStage(ctx);
      })();

      return {
        systemPrompt: event.systemPrompt,
        message: {
          customType: "phenix-flow-stage",
          content: `\u2705 **Verifier subagent running** \u2014 will transition based on verdict`,
          display: true,
          details: {
            stage: "verifying",
            real_subagent: true,
            subagent_role: "verifier",
            model_set: detectFrontendModelSet(ctx),
          },
        },
      };
    }

    if (wf.stage === "replanning") {
      void (async () => {
        try {
          // Use the replanner subagent that includes verifier feedback
          await runFlowReplanner(ctx);
        } catch (err) {
          ctx.ui.notify(
            `\u26a0\ufe0f Replanner execution error: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }

        wf.stage = "executing";
        persistState();

        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Replanner complete \u2014 re-executing revised plan (loop ${wf.loopCount}/${wf.maxLoops})`,
          "info",
        );
        triggerNextStage(ctx);
      })();

      return {
        systemPrompt: event.systemPrompt,
        message: {
          customType: "phenix-flow-stage",
          content: `\ud83d\udd04 **Replanner subagent running** \u2014 will re-execute revised plan`,
          display: true,
          details: {
            stage: "replanning",
            real_subagent: true,
            subagent_role: "planner",
            model_set: detectFrontendModelSet(ctx),
          },
        },
      };
    }

    // Classifying, direct_executing, and synthesizing are agent-turn stages — inject instructions
    const instruction = getStageInstruction(wf.stage, wf);
    const emoji = stageEmoji(wf.stage);
    const label = stageLabel(wf.stage);

    if (!instruction) return;

    return {
      systemPrompt: event.systemPrompt + instruction,
      message: {
        customType: "phenix-flow-stage",
        content: `${emoji} **Flow Stage: ${label}**`,
        display: true,
        details: {
          stage: wf.stage,
          difficulty: wf.difficulty,
          loopCount: wf.loopCount,
          ranRealSubagentScout: wf.ranRealSubagentScout,
          useSubagents: wf.useSubagents,
          subagentRoles: wf.stage === "scouting" ? ["scout", "planner"]
            : wf.stage === "executing" ? ["worker"]
            : wf.stage === "verifying" ? ["verifier"]
            : [],
        },
      },
    };
  });

  // ── agent_end: advance workflow state ──

  pi.on("agent_end", (event, ctx) => {
    if (!state.active || state.workflow.stage === "idle" || state.workflow.stage === "done" || state.workflow.stage === "failed") {
      return;
    }

    // Subagent stages are handled in before_agent_start — skip agent_end for all of them
    const subagentStages = ["scouting", "executing", "verifying", "replanning"];
    if (subagentStages.includes(state.workflow.stage)) {
      return;
    }

    // Get the last assistant message
    const lastAssistant = [...event.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) {
      // No assistant response — stage failed
      state.workflow.stage = "failed";
      state.active = false;
      persistState();
      ctx.ui.notify("❌ Flow workflow failed: no assistant response", "error");
      return;
    }

    const text =
      typeof lastAssistant.content === "string"
        ? lastAssistant.content
        : Array.isArray(lastAssistant.content)
          ? lastAssistant.content
              .map((c: { type?: string; text?: string }) =>
                c.type === "text" ? c.text ?? "" : "",
              )
              .join("\n")
          : "";

    // Advance the workflow state machine
    advanceWorkflow(text);
    const wf = state.workflow;

    if (wf.stage === "done") {
      ctx.ui.notify("🎯 Flow workflow complete!", "info");
      return;
    }

    if (wf.stage === "failed") {
      const parseMsg = wf.verifierParseFailure ? ` (${wf.verifierParseFailure})` : "";
      ctx.ui.notify(
        `❌ Flow workflow failed after ${wf.loopCount} loops (max ${wf.maxLoops})${parseMsg}`,
        "error",
      );
      return;
    }

    if (wf.stage === "idle") {
      return;
    }

    // Trigger the next stage
    ctx.ui.notify(
      `${stageEmoji(wf.stage)} Advancing to: ${stageLabel(wf.stage)} (loop ${wf.loopCount}/${wf.maxLoops})`,
      "info",
    );
    triggerNextStage(ctx);
  });

  // ── /flow command ──

  pi.registerCommand("flow", {
    description: "Start a multi-agent workflow: /flow <prompt>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Subcommands
      if (trimmed === "status" || trimmed === "") {
        if (!state.active) {
          ctx.ui.notify("⏸️ No active flow workflow.", "info");
          return;
        }
        const wf = state.workflow;
        const scoutInfo = wf.ranRealSubagentScout
          ? ` | real_subagent_scout: yes | frontend_model: ${detectFrontendModelSet(ctx)}`
          : "";
        const d0Info = !wf.useSubagents ? " | D0: direct_execution (no subagents)" : "";
        const parseInfo = wf.verifierParseFailure ? ` | verifier_parse_failure: ${wf.verifierParseFailure}` : "";
        const stageDetail = wf.stage === "planning" && wf.scoutEvidence
          ? ` | scout_confidence: ${(wf.scoutEvidence as any).confidence ?? "?"}`
          : "";
        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Flow: ${stageLabel(wf.stage)} | Difficulty: ${wf.difficulty ?? "?"} | Loop: ${wf.loopCount}/${wf.maxLoops}${scoutInfo}${d0Info}${stageDetail}${parseInfo}`,
          "info",
        );
        return;
      }

      if (trimmed === "cancel") {
        if (!state.active) {
          ctx.ui.notify("⏸️ No active flow to cancel.", "info");
          return;
        }
        state.active = false;
        state.workflow = { ...DEFAULT_WORKFLOW };
        persistState();
        ctx.ui.notify("⏹️ Flow workflow cancelled.", "warning");
        return;
      }

      // Parse optional flags
      let prompt = trimmed;
      let difficultyHint: Difficulty | null = null;

      const diffMatch = trimmed.match(/--difficulty\s+(D[0-3])/i);
      if (diffMatch) {
        difficultyHint = diffMatch[1].toUpperCase() as Difficulty;
        prompt = prompt.replace(/--difficulty\s+D[0-3]\s*/i, "").trim();
      }

      // Parse planner interaction mode
      let plannerMode: PlannerInteractionMode = "ask_if_unclear";
      const modeMatch = trimmed.match(/--mode\s+(auto|ask_if_unclear|require_plan_approval|collaborative)/i);
      if (modeMatch) {
        plannerMode = modeMatch[1].toLowerCase() as PlannerInteractionMode;
        prompt = prompt.replace(/--mode\s+\S+\s*/i, "").trim();
      }

      // Parse scout control
      let scoutOverride: "auto" | "force" | "skip" = "auto";
      const scoutMatch = trimmed.match(/--scout\s+(auto|force|skip)/i);
      if (scoutMatch) {
        scoutOverride = scoutMatch[1].toLowerCase() as "auto" | "force" | "skip";
        prompt = prompt.replace(/--scout\s+\S+\s*/i, "").trim();
      }

      // Remove other known flags
      prompt = prompt
        .replace(/--target-state\s+\S+\s*/g, "")
        .trim();

      if (!prompt) {
        ctx.ui.notify(
          "Usage: /flow <prompt>\n  or: /flow --difficulty D2 <prompt>\n  or: /flow --mode ask_if_unclear <prompt>\n  or: /flow --scout auto|force|skip <prompt>\n  or: /flow status\n  or: /flow cancel",
          "warning",
        );
        return;
      }

      // Determine difficulty
      const difficulty = difficultyHint ?? classifyDifficulty(prompt);

      // D0: parent direct execution, no child subagent
      const useSubagents = !isSimpleTask(difficulty);

      // Determine if scout should run (only relevant for D1+)
      const shouldScout = useSubagents
        ? (scoutOverride === "force"
            ? true
            : scoutOverride === "skip"
              ? false
              : shouldRunRepoScout({
                  difficulty,
                  prompt,
                  exactPathsMentioned: [],
                  exactSymbolsMentioned: [],
                }))
        : false;

      // Determine initial stage
      let initialStage: FlowStage;
      if (isSimpleTask(difficulty)) {
        // D0: direct execute — no subagent, no classify step
        initialStage = "direct_executing";
      } else {
        // D1+: classify first, then scout, then plan
        initialStage = shouldScout ? "classifying" : "planning";
      }

      state.active = true;
      const runId = `flow-${Date.now()}`;
      const commDir = ensureCommChannelDir(ctx.cwd);
      state.workflow = {
        ...DEFAULT_WORKFLOW,
        stage: initialStage,
        originalPrompt: prompt,
        difficulty: difficulty,
        plannerInteractionMode: plannerMode,
        useSubagents,
        runId,
        commDir,
      };
      persistState();

      const frontendModel = detectFrontendModelSet(ctx);
      const subagentNote = useSubagents ? "with subagents" : "D0 direct (no subagents)";
      ctx.ui.notify(
        `${stageEmoji(state.workflow.stage)} Starting Phenix flow: **${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}** (${difficulty}, ${subagentNote}${!isSimpleTask(difficulty) && shouldScout ? ", with scout" : !isSimpleTask(difficulty) ? ", no scout" : ""})` +
        `\nFrontend model set: ${frontendModel}`,
        "info",
      );

      // Start the first stage
      triggerNextStage(ctx);
    },
  });
}
