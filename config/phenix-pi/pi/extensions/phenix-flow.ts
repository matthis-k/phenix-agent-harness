/**
 * phenix-flow.ts — Dynamic Multi-Agent Workflow Orchestrator
 *
 * Registers the `/flow` command and manages a Plan → Execute → Verify → Replan
 * workflow state machine. Each stage is a separate agent turn with role-specific
 * system prompt instructions.
 *
 * Stages:
 *   classifying → planning → executing → verifying → synthesizing → done
 *   verifying (fail) → replanning → executing (revised) → verifying ...
 *
 * For simple tasks (D0/D1) the pipeline collapses to single-agent execution.
 *
 * Based on multi-agent workflow research: Planner/Architect decomposes tasks,
 * Developer/Worker implements, Verifier/Critic inspects, Orchestrator manages flow.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

type FlowStage =
  | "idle"
  | "classifying"
  | "planning"
  | "executing"
  | "verifying"
  | "replanning"
  | "synthesizing"
  | "done"
  | "failed";

type Difficulty = "D0" | "D1" | "D2" | "D3";

interface FlowWorkflow {
  stage: FlowStage;
  originalPrompt: string;
  difficulty: Difficulty | null;
  secrecy: string | null;
  changeKind: string | null;
  plan: string | null;
  executionResults: string[];
  verificationResult: string | null;
  loopCount: number;
  maxLoops: number;
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
  executionResults: [],
  verificationResult: null,
  loopCount: 0,
  maxLoops: 3,
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

function isSimpleTask(difficulty: Difficulty): boolean {
  return difficulty === "D0" || difficulty === "D1";
}

function stageEmoji(stage: FlowStage): string {
  const map: Record<FlowStage, string> = {
    idle: "⏸️",
    classifying: "🔍",
    planning: "📋",
    executing: "🔧",
    verifying: "✅",
    replanning: "🔄",
    synthesizing: "📊",
    done: "🎯",
    failed: "❌",
  };
  return map[stage] ?? "❓";
}

function stageLabel(stage: FlowStage): string {
  const map: Record<FlowStage, string> = {
    idle: "Idle",
    classifying: "Classification",
    planning: "Planning",
    executing: "Execution",
    verifying: "Verification",
    replanning: "Revision",
    synthesizing: "Synthesis",
    done: "Complete",
    failed: "Failed",
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
        "## 🏷️ Flow Stage: Task Classification",
        "",
        "Analyze the user's request and classify it by:",
        "- **Difficulty**: D0 (trivial/mechanical — typo, format, obvious rename), D1 (bounded repo-aware — single-file or localized edit), D2 (architectural/multi-file — new abstraction, cross-module change), D3 (high-risk/ambiguous — security, release, cross-repo, secret)",
        "- **Secrecy**: public, private, or secret",
        "- **Change kind**: code, config, docs, workflow, nix, rust, tests, ci, or other",
        "",
        'End your response with a JSON classification block:\n```json\n{"difficulty": "D0|D1|D2|D3", "secrecy": "public|private|secret", "change_kind": "...", "reasoning": "..."}\n```',
      ].join("\n");

    case "planning":
      return [
        "",
        "## 📋 Flow Stage: Planning / Architecture",
        "",
        "You are the **Planner/Architect**. Your role is to:",
        "- Analyze the task and decompose it into ordered, actionable subtasks",
        "- State clear assumptions and success criteria",
        "- Design the overall approach — do NOT execute subtasks or modify files",
        "",
        'End your response with a JSON plan block:\n```json\n{"goal": "...", "subtasks": ["1. ...", "2. ..."], "assumptions": ["..."], "success_criteria": ["..."]}\n```',
      ].join("\n");

    case "executing":
      return [
        "",
        "## 🔧 Flow Stage: Execution",
        "",
        "You are the **Developer/Worker**. Your role is to:",
        "- Implement the subtasks from the plan using available tools",
        "- Edit files, run shell commands, use Git freely (confirm destructive operations like force-push)",
        "- Complete ALL subtasks before finishing your response",
        "- Summarize what was done and any noteworthy results",
      ].join("\n");

    case "verifying":
      return [
        "",
        "## ✅ Flow Stage: Verification",
        "",
        "You are the **Verifier/Critic**. Inspect the completed work:",
        "- Are all subtasks from the plan complete?",
        "- Are there errors, bugs, or policy violations?",
        "- Do the success criteria pass?",
        "- Are there any missing pieces or regressions?",
        "",
        'End your response with a JSON verdict:\n```json\n{"verdict": "pass" | "fail", "issues": ["..."], "feedback": "..."}\n```',
      ].join("\n");

    case "replanning":
      return [
        "",
        "## 🔄 Flow Stage: Revision",
        "",
        "You are the **Planner**. The verification found issues. Revise the plan to address the feedback.",
        "",
        'Output an updated JSON plan:\n```json\n{"goal": "...", "subtasks": ["1. ...", "2. ..."], "revision_notes": "..."}\n```',
      ].join("\n");

    case "synthesizing":
      return [
        "",
        "## 📊 Flow Stage: Synthesis",
        "",
        "You are the **Orchestrator**. Compile a final summary of:",
        "- What was accomplished",
        "- Changes made (files modified, commands run)",
        "- Verification outcome",
        "- Any remaining notes or follow-up items",
      ].join("\n");

    default:
      return null;
  }
}

// ──────────────────────────────────────────────
// Stage context (injected as a visible message)
// ──────────────────────────────────────────────

function getStageContext(stage: FlowStage, wf: FlowWorkflow): string {
  const header = `**${stageEmoji(stage)} Flow Stage: ${stageLabel(stage)}**\n\n`;

  switch (stage) {
    case "classifying":
      return `${header}Classifying the following request:\n\n${wf.originalPrompt}`;

    case "planning":
      return (
        `${header}Creating a plan for:\n\n${wf.originalPrompt}` +
        (wf.difficulty ? `\n\n*Classified as ${wf.difficulty}, ${wf.secrecy ?? "?"}, ${wf.changeKind ?? "?"}*` : "")
      );

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

  // Try standalone { ... } object (greedy, but works for well-formed JSON)
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
// Workflow stage transitions
// ──────────────────────────────────────────────

function nextStage(stage: FlowStage, verdict?: string): FlowStage {
  switch (stage) {
    case "classifying":
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
  const verdict = wf.stage === "verifying" ? extractVerdict(assistantText) : undefined;

  // Check loop limits for replanning cycles
  if (
    wf.stage === "verifying" &&
    verdict === "fail" &&
    wf.loopCount >= wf.maxLoops
  ) {
    wf.stage = "failed";
    state.active = false;
    (globalThis as any).__phenixFlowActive = false;
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

  // For simple tasks (D0/D1), skip planning/replanning — go straight to execute
  if (
    isSimpleTask(wf.difficulty ?? "D1") &&
    (next === "planning" || next === "replanning")
  ) {
    wf.stage = "executing";
  } else {
    wf.stage = next;
  }

  persistState();
}

// ──────────────────────────────────────────────
// Trigger next stage via user message
// ──────────────────────────────────────────────
// Fire-and-forget: sends user message to trigger next stage.
// Returns void so the pipeline doesn't crash on promise errors.

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
        },
      },
    };
  });

  // ── agent_end: advance workflow state ──

  pi.on("agent_end", (event, ctx) => {
    if (!state.active || state.workflow.stage === "idle" || state.workflow.stage === "done" || state.workflow.stage === "failed") {
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
      (globalThis as any).__phenixFlowActive = false;
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
      ctx.ui.notify(
        `❌ Flow workflow failed after ${wf.loopCount} loops (max ${wf.maxLoops})`,
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
        ctx.ui.notify(
          `${stageEmoji(wf.stage)} Flow: ${stageLabel(wf.stage)} | Difficulty: ${wf.difficulty ?? "?"} | Loop: ${wf.loopCount}/${wf.maxLoops}`,
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
        (globalThis as any).__phenixFlowActive = false;
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

      // Remove other known flags
      prompt = prompt
        .replace(/--mode\s+\S+\s*/g, "")
        .replace(/--target-state\s+\S+\s*/g, "")
        .trim();

      if (!prompt) {
        ctx.ui.notify(
          "Usage: /flow <prompt>\n  or: /flow --difficulty D2 <prompt>\n  or: /flow status\n  or: /flow cancel",
          "warning",
        );
        return;
      }

      // Initialize workflow
      const difficulty = difficultyHint ?? classifyDifficulty(prompt);
      const complex = !isSimpleTask(difficulty);

      state.active = true;
      state.workflow = {
        ...DEFAULT_WORKFLOW,
        stage: complex ? "classifying" : "executing",
        originalPrompt: prompt,
        difficulty: difficulty,
      };
      persistState();
      // Signal to phenix-router that flow is active (suppress its retry logic)
      (globalThis as any).__phenixFlowActive = true;

      ctx.ui.notify(
        `${stageEmoji(state.workflow.stage)} Starting Phenix flow: **${prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt}** (${difficulty}${complex ? ", multi-stage" : ", single-agent"})`,
        "info",
      );

      // Start the first stage
      triggerNextStage(ctx);
    },
  });
}
