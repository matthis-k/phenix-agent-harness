/**
 * phenix-flow.ts — Phenix workflow dispatch.
 *
 * When a phenix model is selected, every user prompt is auto-routed
 * through a workflow chain: the prompt is classified (difficulty),
 * a chain file is selected, and chain instructions are injected into
 * the system prompt before the LLM processes the turn.
 *
 * Explicit /flow command:
 *   /flow [--difficulty D0|D1|D2|D3] <prompt>
 *   /flow status    — show active workflow
 *   /flow cancel    — cancel active workflow
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowRoute, classifyDifficulty } from "../lib/phenix-routing-matrix";
import type { Variant, Difficulty, CostMode, TargetState } from "../lib/phenix-routing-matrix";

// ── Types ──

interface FlowState {
  active: boolean;
  chainName: string | null;
  difficulty: Difficulty | null;
  prompt: string | null;
}

interface ChainStep {
  agent: string;
  phase: string;
  label: string;
  model?: string;
  thinking?: string;
  instruction: string;
}

// ── State ──

const DEFAULT_COST: CostMode = "balanced";
const DEFAULT_VARIANT: Variant = "mixed";
const DEFAULT_TARGET: TargetState = "dev-wallet";

let state: FlowState = {
  active: false,
  chainName: null,
  difficulty: null,
  prompt: null,
};

// ── Helpers ──

function isPhenixModel(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "phenix";
}

function chainFile(configDir: string, name: string): string | null {
  const candidates = [
    resolve(configDir, "chains", name + ".chain.md"),
    resolve(configDir, "chains", name + ".chain.json"),
  ];
  for (const f of candidates) {
    if (existsSync(f)) return f;
  }
  return null;
}

function parseChainSteps(filePath: string, prompt: string): ChainStep[] {
  const content = readFileSync(filePath, "utf-8").trim();

  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      const steps = parsed.chain ?? [];
      return steps.map((s: any) => ({
        agent: s.agent ?? "unknown",
        phase: s.phase ?? "",
        label: s.label ?? "",
        model: s.model,
        thinking: s.thinking,
        instruction: replaceTokens(s.task ?? s.instruction ?? "", prompt),
      }));
    } catch {
      return [];
    }
  }

  // Markdown chain format: ## <agent-name>\nkey: value\n\nbody
  const steps: ChainStep[] = [];
  const blocks = content.split(/^## /m).slice(1);
  for (const block of blocks) {
    const lines = block.split("\n");
    const agent = lines[0]?.trim() ?? "unknown";
    const bodyStart = lines.findIndex((l) => l.trim() && !l.includes(":"));
    const headerLines = lines.slice(1, bodyStart > 0 ? bodyStart : undefined);
    const bodyLines = bodyStart > 0 ? lines.slice(bodyStart) : lines.slice(1);

    const getVal = (key: string): string | undefined => {
      for (const l of headerLines) {
        const m = l.match(new RegExp(`^${key}:\\s*(.*)$`));
        if (m) return m[1];
      }
      return undefined;
    };

    steps.push({
      agent,
      phase: getVal("phase") ?? "",
      label: getVal("label") ?? "",
      model: getVal("model"),
      thinking: getVal("thinking"),
      instruction: replaceTokens(bodyLines.join("\n").trim(), prompt),
    });
  }

  return steps;
}

function replaceTokens(text: string, _prompt: string): string {
  return text
    .replace(/\{outputs\.context\}/g, "(scout output will be gathered first)")
    .replace(/\{outputs\.plan\}/g, "(plan will be produced)")
    .replace(/\{outputs\.patch\}/g, "(patch will be applied)")
    .replace(/\{previous\}/g, _prompt);
}

function buildChainSystemPrompt(steps: ChainStep[], originalPrompt: string): string {
  const parts: string[] = [
    "## Phenix Workflow Chain",
    "",
    `Task: ${originalPrompt}`,
    "",
    "Follow this workflow step by step. Complete each phase before moving to the next.",
    "",
  ];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    parts.push(`### Step ${i + 1}: ${s.label} (${s.agent})`);
    if (s.model) parts.push(`Model: ${s.model}`);
    if (s.thinking) parts.push(`Thinking: ${s.thinking}`);
    parts.push("");
    parts.push(s.instruction);
    parts.push("");
  }

  parts.push("---");
  parts.push("After completing all steps, summarize what was done.");

  return parts.join("\n");
}

function chainForDifficulty(difficulty: Difficulty, _variant: string): string {
  switch (difficulty) {
    case "D0": return "phenix-d0";
    case "D1": return "phenix-d1";
    case "D2": return "phenix-d2";
    case "D3": return "phenix-d3";
  }
}

function parseFlags(args: string): {
  prompt: string;
  difficulty: Difficulty | null;
  variant: Variant | null;
  costMode: CostMode | null;
  targetState: TargetState | null;
} {
  let remaining = args;

  const diffMatch = remaining.match(/--difficulty\s+(D[0-3])/i);
  const difficulty = diffMatch ? diffMatch[1].toUpperCase() as Difficulty : null;
  if (diffMatch) remaining = remaining.replace(/--difficulty\s+D[0-3]\s*/i, "");

  const variantMatch = remaining.match(/--variant\s+(free|opencode-go|gpt|mixed)/i);
  const variant = variantMatch ? variantMatch[1].toLowerCase() as Variant : null;
  if (variantMatch) remaining = remaining.replace(/--variant\s+\S+\s*/i, "");

  const costMatch = remaining.match(/--cost\s+(economy|balanced|quality)/i);
  const costMode = costMatch ? costMatch[1].toLowerCase() as CostMode : null;
  if (costMatch) remaining = remaining.replace(/--cost\s+\S+\s*/i, "");

  const targetMatch = remaining.match(/--target\s+(scratch|dev-wallet|main-bound)/i);
  const targetState = targetMatch ? targetMatch[1].toLowerCase() as TargetState : null;
  if (targetMatch) remaining = remaining.replace(/--target\s+\S+\s*/i, "");

  remaining = remaining.replace(/--\S+\s*/g, "").trim();

  return { prompt: remaining, difficulty, variant, costMode, targetState };
}

// ── Extension entry ──

export default function phenixFlow(pi: ExtensionAPI) {
  let configDir = "";

  // Discover config dir from extension path
  pi.on("session_start", (_ev, ctx) => {
    const extUrl = import.meta.url;
    if (extUrl) {
      const extPath = extUrl.startsWith("file://") ? extUrl.slice(7) : extUrl;
      configDir = resolve(dirname(extPath), "..");
    } else {
      configDir = ctx.cwd;
    }
  });

  // ── Auto-route phenix model inputs through flow ──
  pi.on("input", (ev, ctx) => {
    // Only auto-route when a phenix/* model is active
    if (!isPhenixModel(ctx)) return { action: "continue" as const };
    if (state.active) return { action: "continue" as const };
    if (!ev.text || ev.text.startsWith("/")) return { action: "continue" as const };
    // First prompt with a phenix model activates the flow
    const prompt = ev.text;
    const difficulty = classifyDifficulty(prompt);
    const chainName = chainForDifficulty(difficulty, DEFAULT_VARIANT);

    state.active = true;
    state.chainName = chainName;
    state.difficulty = difficulty;
    state.prompt = prompt;

    // The prompt passes through to before_agent_start where chain instructions get injected
    return { action: "continue" as const };
  });

  // ── Inject chain instructions before LLM processes the turn ──
  pi.on("before_agent_start", (ev, ctx) => {
    if (!state.active || !state.chainName || !state.prompt) return;

    const cf = chainFile(configDir, state.chainName);
    if (!cf) {
      ctx.ui.notify(`Chain file not found: ${state.chainName}`, "warning");
      return;
    }

    const steps = parseChainSteps(cf, state.prompt);
    if (steps.length === 0) {
      ctx.ui.notify(`Empty chain: ${state.chainName}`, "warning");
      return;
    }

    const chainPrompt = buildChainSystemPrompt(steps, state.prompt);

    return {
      systemPrompt: ev.systemPrompt + "\n\n" + chainPrompt,
    };
  });

  // ── /flow command ──
  pi.registerCommand("flow", {
    description: "Route a task through Phenix workflow. Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>",
    handler: (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "status" || trimmed === "") {
        if (!state.active) {
          ctx.ui.notify("⏸️ No active flow.", "info");
          return;
        }
        ctx.ui.notify(`Active flow: ${state.chainName} (${state.difficulty})`, "info");
        return;
      }

      if (trimmed === "cancel") {
        if (!state.active) {
          ctx.ui.notify("⏸️ No active flow.", "info");
          return;
        }
        state.active = false;
        state.chainName = null;
        state.difficulty = null;
        state.prompt = null;
        ctx.ui.notify("⏹️ Flow cancelled.", "warning");
        return;
      }

      const flags = parseFlags(trimmed);
      const prompt = flags.prompt;

      if (!prompt) {
        ctx.ui.notify(
          "Usage: /flow [--difficulty D0|D1|D2|D3] <prompt>\n  or: /flow status\n  or: /flow cancel",
          "warning",
        );
        return;
      }

      const difficulty = flags.difficulty ?? classifyDifficulty(prompt);
      const variant = flags.variant ?? DEFAULT_VARIANT;
      const costMode = flags.costMode ?? DEFAULT_COST;
      const targetState = flags.targetState ?? DEFAULT_TARGET;

      const route = resolveWorkflowRoute({ variant, difficulty, costMode, secrecy: "public", changeKind: "feature", targetState });

      if (!route.allowed) {
        ctx.ui.notify(`🚫 Flow denied: ${route.denialReason ?? "Not allowed."}`, "error");
        return;
      }

      const chainName = chainForDifficulty(difficulty, variant);

      if (route.warnings.length > 0) {
        ctx.ui.notify(`⚠️ ${route.warnings.join("; ")}`, "warning");
      }

      state.active = true;
      state.chainName = chainName;
      state.difficulty = difficulty;
      state.prompt = prompt;

      ctx.ui.notify(`🚀 Phenix workflow — ${difficulty} | Chain: ${chainName}`, "info");
    },
  });

  // ── Reset state after each agent turn so the next prompt gets a fresh chain ──
  pi.on("agent_end", () => {
    state.active = false;
    state.chainName = null;
    state.difficulty = null;
    state.prompt = null;
  });

  // ── Cleanup ──
  pi.on("session_end", () => {
    state.active = false;
    state.chainName = null;
    state.difficulty = null;
    state.prompt = null;
  });
}
