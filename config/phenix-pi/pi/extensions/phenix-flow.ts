/**
 * phenix-flow.ts — Phenix workflow dispatch.
 *
 * When a phenix model is selected, every user prompt is auto-routed
 * through a workflow chain: the prompt is classified (difficulty),
 * a chain file is selected, and phases are dispatched one at a time,
 * each with its specified model and thinking level.
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
  justFinished: boolean;
  chainName: string | null;
  steps: ChainStep[];
  currentStep: number;
  difficulty: Difficulty | null;
  originalPrompt: string;
  /** model ref (provider/id) of the model active when the workflow started */
  originalModelRef: string | null;
  /** outputs keyed by step's `as` tag, populated after each phase completes */
  outputs: Record<string, string>;
}

interface ChainStep {
  agent: string;
  phase: string;
  label: string;
  as?: string;
  output?: string;
  outputMode?: string;
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
  justFinished: false,
  chainName: null,
  steps: [],
  currentStep: -1,
  difficulty: null,
  originalPrompt: "",
  originalModelRef: null,
  outputs: {},
};

// ── Helpers ──

function isPhenixModel(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "phenix";
}

function modelRefKey(ctx: ExtensionContext): string | null {
  if (!ctx.model) return null;
  return `${ctx.model.provider}/${ctx.model.id}`;
}

function parseModelRef(ref: string): { provider: string; model: string } | null {
  const slash = ref.indexOf("/");
  if (slash === -1) return null;
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
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
      const raw = parsed.chain ?? [];
      const steps: ChainStep[] = [];
      for (const s of raw) {
        if (s.parallel) {
          // parallel blocks: flatten as sequential steps for now (each dispatched separately)
          for (const p of s.parallel) {
            steps.push({
              agent: p.agent ?? "unknown",
              phase: p.phase ?? "",
              label: p.label ?? "",
              as: p.as,
              output: p.output,
              outputMode: p.outputMode,
              model: p.model,
              thinking: p.thinking,
              instruction: replaceTokens(p.task ?? p.instruction ?? "", prompt, {}),
            });
          }
        } else {
          steps.push({
            agent: s.agent ?? "unknown",
            phase: s.phase ?? "",
            label: s.label ?? "",
            as: s.as,
            output: s.output,
            outputMode: s.outputMode,
            model: s.model,
            thinking: s.thinking,
            instruction: replaceTokens(s.task ?? s.instruction ?? "", prompt, {}),
          });
        }
      }
      return steps;
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
      as: getVal("as"),
      output: getVal("output"),
      outputMode: getVal("outputMode"),
      model: getVal("model"),
      thinking: getVal("thinking"),
      instruction: replaceTokens(bodyLines.join("\n").trim(), prompt, {}),
    });
  }

  return steps;
}

function replaceTokens(text: string, _prompt: string, outputs: Record<string, string>): string {
  let result = text;
  // Replace {outputs.<key>} with actual output content or file path hint
  result = result.replace(/\{outputs\.(\w+)\}/g, (_match, key) => {
    if (outputs[key]) {
      return outputs[key];
    }
    return `(output from ${key} phase will be gathered)`;
  });
  result = result.replace(/\{previous\}/g, _prompt);
  return result;
}

function buildStepPrompt(step: ChainStep, originalPrompt: string, outputs: Record<string, string>): string {
  const parts: string[] = [
    "## Phenix Workflow Phase",
    "",
    `Task: ${originalPrompt}`,
    "",
    `### Phase: ${step.label} (${step.agent})`,
  ];
  if (step.model) parts.push(`Model: ${step.model}`);
  if (step.thinking) parts.push(`Thinking: ${step.thinking}`);
  parts.push("");
  // Replace tokens with current outputs
  const instruction = replaceTokens(step.instruction, originalPrompt, outputs);
  parts.push(instruction);
  parts.push("");
  if (step.output) {
    parts.push(`Write your output to \`${step.output}\`. This will be consumed by the next phase.`);
    parts.push("");
  }
  parts.push("---");

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

function resetFlowState(): void {
  state.active = false;
  state.chainName = null;
  state.steps = [];
  state.currentStep = -1;
  state.difficulty = null;
  state.originalPrompt = "";
  state.originalModelRef = null;
  state.outputs = {};
}

/**
 * Read a phase's output file if it exists after the phase completes.
 * The content is stored in state.outputs keyed by step.as so that
 * {outputs.<as>} tokens in later phases are replaced with real content.
 */
function capturePhaseOutput(step: ChainStep, cwd: string): void {
  const key = step.as || step.agent;
  if (!step.output) return;
  try {
    const filePath = resolve(cwd, step.output);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      state.outputs[key] = content;
    }
  } catch {
    // file may not exist yet — that's fine
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
    // If a flow just finished, ignore residual messages to prevent re-triggering
    if (state.justFinished) {
      state.justFinished = false;
      return { action: "continue" as const };
    }
    // If a flow is already active, let continuation messages pass through
    if (state.active) return { action: "continue" as const };
    if (!ev.text || ev.text.startsWith("/")) return { action: "continue" as const };

    const prompt = ev.text;
    const difficulty = classifyDifficulty(prompt);
    const chainName = chainForDifficulty(difficulty, DEFAULT_VARIANT);

    const cf = chainFile(configDir, chainName);
    if (!cf) {
      ctx.ui.notify(`Chain file not found: ${chainName}`, "warning");
      return { action: "continue" as const };
    }

    const steps = parseChainSteps(cf, prompt);
    if (steps.length === 0) {
      ctx.ui.notify(`Empty chain: ${chainName}`, "warning");
      return { action: "continue" as const };
    }

    state.active = true;
    state.chainName = chainName;
    state.steps = steps;
    state.currentStep = 0;
    state.difficulty = difficulty;
    state.originalPrompt = prompt;
    state.originalModelRef = modelRefKey(ctx);
    state.outputs = {};

    return { action: "continue" as const };
  });

  // ── Inject ONLY the current phase into the system prompt and set model/thinking ──
  pi.on("before_agent_start", (ev, ctx) => {
    if (!state.active || state.currentStep < 0 || state.currentStep >= state.steps.length) return;

    const step = state.steps[state.currentStep];

    // Switch model for this phase
    if (step.model) {
      const parsed = parseModelRef(step.model);
      if (parsed) {
        const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
        if (model) {
          pi.setModel(model);
        }
      }
    }

    // Set thinking level for this phase
    if (step.thinking) {
      try {
        (pi as any).setThinkingLevel?.(step.thinking);
      } catch {
        // thinking level API may not be available
      }
    }

    // Build prompt for ONLY this step (not all steps)
    const stepPrompt = buildStepPrompt(step, state.originalPrompt, state.outputs);

    return {
      systemPrompt: ev.systemPrompt + "\n\n" + stepPrompt,
    };
  });

  // ── After each phase completes, advance to next and dispatch continuation ──
  pi.on("agent_end", async (_ev, ctx) => {
    if (!state.active || state.currentStep < 0 || state.currentStep >= state.steps.length) return;

    // Capture output from the completed phase
    const completedStep = state.steps[state.currentStep];
    capturePhaseOutput(completedStep, ctx.cwd);

    // If phase requires an output file but it doesn't exist, give same agent another turn
    if (completedStep.output) {
      const outputPath = resolve(ctx.cwd, completedStep.output);
      if (!existsSync(outputPath)) {
        const instruction = buildStepPrompt(completedStep, state.originalPrompt, state.outputs);
        pi.sendUserMessage(instruction, {
          deliverAs: "followUp",
          triggerTurn: true,
        });
        return;
      }
    }

    // Advance to next step
    state.currentStep++;

    // All phases complete
    if (state.currentStep >= state.steps.length) {
      // Restore original model
      if (state.originalModelRef) {
        const parsed = parseModelRef(state.originalModelRef);
        if (parsed) {
          const originalModel = ctx.modelRegistry.find(parsed.provider, parsed.model);
          if (originalModel) {
            pi.setModel(originalModel);
          }
        }
      }
      state.justFinished = true;
      resetFlowState();
      return;
    }

    const nextStep = state.steps[state.currentStep];

    // Switch model for next phase
    if (nextStep.model) {
      const parsed = parseModelRef(nextStep.model);
      if (parsed) {
        const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
        if (model) {
          await pi.setModel(model);
        }
      }
    }

    // Set thinking level for next phase
    if (nextStep.thinking) {
      try {
        (pi as any).setThinkingLevel?.(nextStep.thinking);
      } catch {
        // thinking level API may not be available
      }
    }

    // Build continuation instruction for the next phase
    const instruction = buildStepPrompt(nextStep, state.originalPrompt, state.outputs);

    // Send a continuation message to trigger the next phase
    pi.sendUserMessage(instruction, {
      deliverAs: "followUp",
      triggerTurn: true,
    });
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
        const step = state.currentStep >= 0 && state.currentStep < state.steps.length
          ? state.steps[state.currentStep]
          : null;
        const stepInfo = step
          ? ` | Phase ${state.currentStep + 1}/${state.steps.length}: ${step.label} (${step.model || "default model"})`
          : "";
        ctx.ui.notify(`Active flow: ${state.chainName} (${state.difficulty})${stepInfo}`, "info");
        return;
      }

      if (trimmed === "cancel") {
        if (!state.active) {
          ctx.ui.notify("⏸️ No active flow.", "info");
          return;
        }
        resetFlowState();
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

      const cf = chainFile(configDir, chainName);
      if (!cf) {
        ctx.ui.notify(`Chain file not found: ${chainName}`, "warning");
        return;
      }

      const steps = parseChainSteps(cf, prompt);
      if (steps.length === 0) {
        ctx.ui.notify(`Empty chain: ${chainName}`, "warning");
        return;
      }

      if (route.warnings.length > 0) {
        ctx.ui.notify(`⚠️ ${route.warnings.join("; ")}`, "warning");
      }

      state.active = true;
      state.chainName = chainName;
      state.steps = steps;
      state.currentStep = 0;
      state.difficulty = difficulty;
      state.originalPrompt = prompt;
      state.originalModelRef = modelRefKey(ctx);
      state.outputs = {};

      ctx.ui.notify(`🚀 Phenix workflow — ${difficulty} | Chain: ${chainName} | ${steps.length} phases`, "info");
    },
  });

  // ── Cleanup ──
  pi.on("session_end", () => {
    resetFlowState();
  });
}
