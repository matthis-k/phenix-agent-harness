import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  formatIntegrationReport,
  type IntegrationStatus,
  loadPiIntegrations,
  summarizeIntegrations,
} from "../adapters/pi-sdk/integrations.ts";
import { registerPhenixProvider } from "../adapters/routing/phenix-provider.ts";
import { createPhenixRuntime, type PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import { isPhenixModelSet, PHENIX_MODEL_SETS } from "../domain/definition/model.ts";
import {
  DEFAULT_SESSION_PROFILE,
  isSessionAgentPreset,
  SESSION_AGENT_PRESETS,
  type SessionAgentPreset,
  type SessionProfile,
} from "../domain/run/model.ts";
import { type RunId, runId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import { copyFactHistory, parseFactsCommand, writeFactHistory } from "./fact-export.ts";
import { formatDiagnosticEntries, PHENIX_LOGS_USAGE, parseLogsCommand } from "./log-command.ts";
import { statusLine } from "./observability-theme.ts";
import {
  completePhenixSubcommands,
  PHENIX_FACTS_USAGE,
  PHENIX_STATUS_USAGE,
  PHENIX_USAGE,
} from "./phenix-command.ts";
import { RunMonitor } from "./run-monitor.ts";

const ROOT_BINDING_ENTRY = "phenix:root-binding";
const STATUS_KEY = "phenix";

interface RootBinding {
  readonly sessionId: string;
  readonly rootRunId: RunId;
  readonly lastSequence: number;
}

export default async function phenixRootExtension(pi: ExtensionAPI): Promise<void> {
  let runtime: PhenixRuntime | undefined;
  let rootRunId: RunId | undefined;
  let modelRegistry: ModelRegistry | undefined;
  let toolsRegistered = false;
  let disposeStatus: (() => void) | undefined;
  let monitor: RunMonitor | undefined;
  let integrationStatuses: readonly IntegrationStatus[] = [];

  registerPhenixProvider(pi, {
    modelRegistry: () => modelRegistry,
    profile: async () => {
      if (!runtime || !rootRunId) return DEFAULT_SESSION_PROFILE;
      return runtime.profiles.current(rootRunId);
    },
  });
  integrationStatuses = await loadPiIntegrations(pi);

  pi.on("session_start", async (_event, ctx) => {
    const previousRuntime = runtime;
    const previousRoot = rootRunId;
    runtime = undefined;
    rootRunId = undefined;
    modelRegistry = ctx.modelRegistry;
    disposeStatus?.();
    disposeStatus = undefined;
    monitor?.dispose();
    monitor = undefined;
    if (previousRuntime && previousRoot) await previousRuntime.shutdown(previousRoot);

    const sessionId = ctx.sessionManager.getSessionId();
    const binding = findRootBinding(ctx, sessionId);
    rootRunId = binding?.rootRunId ?? runId(`root-${sessionId}`);
    runtime = await createPhenixRuntime({
      cwd: ctx.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
      stateDir: path.join(ctx.cwd, ".phenix-agent-state"),
      modelRegistry: ctx.modelRegistry,
      piEventBus: pi.events,
    });
    const currentRuntime = runtime;
    const currentRoot = rootRunId;
    currentRuntime.setRootNotifier(async (message) => {
      ctx.ui.notify(message, "info");
      pi.sendMessage(
        {
          customType: "phenix:background-completion",
          content: message,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    });
    await currentRuntime.startRoot({
      id: currentRoot,
      session: {
        sessionId,
        ...(ctx.sessionManager.getSessionFile()
          ? { sessionFile: ctx.sessionManager.getSessionFile() }
          : {}),
        cwd: ctx.cwd,
      },
      ...(ctx.model && ctx.model.provider !== "phenix"
        ? { model: concreteModel(ctx.model.provider, ctx.model.id) }
        : {}),
    });
    if (ctx.model?.provider === "phenix" && isPhenixModelSet(ctx.model.id)) {
      await currentRuntime.profiles.select(currentRoot, {
        modelSet: ctx.model.id,
        source: "model-select",
      });
    }

    await Promise.all(
      integrationStatuses.map((status) =>
        currentRuntime.diagnostics.record({
          rootRunId: currentRoot,
          runId: currentRoot,
          severity: status.state === "failed" ? "warning" : "info",
          scope:
            status.state === "failed"
              ? "integration.runtime.load_failed"
              : "integration.runtime.loaded",
          message:
            status.state === "failed"
              ? `Integration ${status.id} failed to load`
              : `Integration ${status.id} loaded`,
          fields: { id: status.id, state: status.state, error: status.error },
        }),
      ),
    );

    if (!toolsRegistered) {
      for (const tool of await currentRuntime.rootTools(currentRoot)) {
        registerAgentTool(pi, tool, async () => {
          const activeRuntime = runtime;
          const activeRoot = rootRunId;
          if (!activeRuntime || !activeRoot) throw new Error(`Phenix runtime is not initialized`);
          const activeTool = (await activeRuntime.rootTools(activeRoot)).find(
            (candidate) => candidate.name === tool.name,
          );
          if (!activeTool) throw new Error(`Phenix tool ${tool.name} is unavailable`);
          return activeTool;
        });
      }
      toolsRegistered = true;
    }
    monitor = new RunMonitor(ctx, currentRuntime, currentRoot, {
      integrations: summarizeIntegrations(integrationStatuses),
      integrationsFailed: integrationStatuses.some((status) => status.state === "failed"),
    });
    const refresh = (): void => {
      void updateStatus(ctx, currentRuntime, currentRoot);
      void monitor?.refresh();
    };
    const unsubscribeEvents = currentRuntime.events.subscribe(refresh);
    const unsubscribeLogs = currentRuntime.diagnostics.subscribe(refresh);
    disposeStatus = () => {
      unsubscribeEvents();
      unsubscribeLogs();
    };
    await applyAgentTools(pi, ctx, (await currentRuntime.profiles.current(currentRoot)).agent);
    await updateStatus(ctx, currentRuntime, currentRoot);
    appendBinding(pi, currentRuntime, currentRoot, sessionId);
  });

  pi.on("before_agent_start", async (event) => {
    if (!runtime || !rootRunId) return;
    const [available, active, profile] = await Promise.all([
      runtime.catalog.listAvailable(rootRunId),
      runtime.queries.activeRuns(rootRunId),
      runtime.profiles.current(rootRunId),
    ]);
    const capabilities = available.map((definition) => definition.id).join(", ");
    const handles = active
      .filter((run) => run.id !== rootRunId)
      .map((run) => `${run.id}:${run.state}`)
      .join(", ");
    return {
      systemPrompt: `${event.systemPrompt}\n\n${agentInstructions(profile.agent)}\n\nPhenix execution scope:\n- Session profile: agent=${profile.agent}, modelSet=${profile.modelSet}, difficulty=${profile.difficulty}.\n- Directly answer only simple read-only questions.
- All substantial work MUST use phenix_dispatch with mode=auto so the mandatory selector chooses from the current capability-filtered catalog descriptions.
- Do not choose qa, implement, or coordinate yourself unless the user explicitly requests that operator override.
- The selector should prefer the most specific invariant workflow and use the generic coordinator only when no single workflow covers the whole request or execution depends on intermediate results.
- Never reproduce an invariant workflow manually; phenix_dispatch is the only root execution entry point.
- When any descendant fails, inform the user immediately, inspect the structured failure and cause run, then decide whether to retry with phenix_handle, dispatch a better-suited workflow, request user input, or stop.
- Retry only with bounded settings and the minimum additional permissions needed; recovery may add read/search tools or explicitly escalate to bash, but never add edit/write directly to a read-only task; report every escalation to the user.
- Available definitions: ${capabilities || "none"}.\n- Active descendant handles: ${handles || "none"}.\n- A background child remains attached. Use phenix_handle to inspect, await, send, or cancel it.\n- Use phenix_tasks only for local leaves; execution anchors are derived and read-only.`,
    };
  });

  pi.on("input", async (event) => {
    if (!runtime || !rootRunId || event.source === "extension") return;
    await runtime.amendRootInput(rootRunId, event.text);
  });

  pi.on("model_select", async (event) => {
    if (!runtime || !rootRunId) return;
    if (event.model.provider === "phenix" && isPhenixModelSet(event.model.id)) {
      await runtime.profiles.select(rootRunId, {
        modelSet: event.model.id,
        source: "model-select",
      });
      return;
    }
    await runtime.observeRootModel(rootRunId, concreteModel(event.model.provider, event.model.id));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const currentRuntime = runtime;
    const currentRoot = rootRunId;
    runtime = undefined;
    rootRunId = undefined;
    modelRegistry = undefined;
    disposeStatus?.();
    disposeStatus = undefined;
    monitor?.dispose();
    monitor = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!currentRuntime || !currentRoot) return;
    await currentRuntime.shutdown(currentRoot);
    appendBinding(pi, currentRuntime, currentRoot, ctx.sessionManager.getSessionId());
  });

  pi.registerCommand("agent", {
    description: "Select the root-session Phenix agent preset; usage: /agent [preset]",
    handler: async (args, ctx) => {
      const active = requireRuntime(runtime, rootRunId);
      const selected = args.trim().toLowerCase();
      if (!selected) {
        const profile = await active.runtime.profiles.current(active.root);
        ctx.ui.notify(
          `Agent: ${profile.agent}\nAvailable: ${SESSION_AGENT_PRESETS.join(", ")}`,
          "info",
        );
        return;
      }
      if (!isSessionAgentPreset(selected)) {
        ctx.ui.notify(
          `Unknown agent preset. Available: ${SESSION_AGENT_PRESETS.join(", ")}`,
          "warning",
        );
        return;
      }
      const profile = await active.runtime.profiles.select(active.root, {
        agent: selected,
        source: "user",
      });
      await applyAgentTools(pi, ctx, profile.agent);
      await updateStatus(ctx, active.runtime, active.root);
    },
  });

  pi.registerCommand("modelset", {
    description:
      "Select the session Phenix model set; usage: /modelset [free|opencode-go|chatgpt-plus|mixed]",
    handler: async (args, ctx) => {
      const active = requireRuntime(runtime, rootRunId);
      const selected = args.trim().toLowerCase();
      if (!selected) {
        const profile = await active.runtime.profiles.current(active.root);
        ctx.ui.notify(
          `Model set: ${profile.modelSet}\nAvailable: ${PHENIX_MODEL_SETS.join(", ")}`,
          "info",
        );
        return;
      }
      if (!isPhenixModelSet(selected)) {
        ctx.ui.notify(`Unknown model set. Available: ${PHENIX_MODEL_SETS.join(", ")}`, "warning");
        return;
      }
      const model = ctx.modelRegistry.find("phenix", selected);
      if (!model || !(await pi.setModel(model))) {
        ctx.ui.notify(`Unable to activate phenix/${selected}.`, "warning");
        return;
      }
      await active.runtime.profiles.select(active.root, {
        modelSet: selected,
        source: "user",
      });
      await updateStatus(ctx, active.runtime, active.root);
    },
  });

  pi.registerCommand("difficulty", {
    description: "Select routed reasoning difficulty; usage: /difficulty D0|D1|D2|D3",
    handler: async (args, ctx) => {
      const active = requireRuntime(runtime, rootRunId);
      const selected = args.trim().toUpperCase();
      if (!isDifficulty(selected)) {
        const profile = await active.runtime.profiles.current(active.root);
        ctx.ui.notify(
          `Difficulty: ${profile.difficulty}\nAvailable: D0, D1, D2, D3`,
          selected ? "warning" : "info",
        );
        return;
      }
      await active.runtime.profiles.select(active.root, {
        difficulty: selected,
        source: "user",
      });
      pi.setThinkingLevel(thinkingForDifficulty(selected));
      await updateStatus(ctx, active.runtime, active.root);
    },
  });

  pi.registerCommand("phenix", {
    description: `Inspect Phenix; usage: ${PHENIX_USAGE}`,
    getArgumentCompletions: completePhenixSubcommands,
    handler: async (args, ctx) => {
      const activeRuntime = runtime;
      const activeRoot = rootRunId;
      if (!activeRuntime || !activeRoot) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      const trimmed = args.trim();
      const separator = trimmed.search(/\s/);
      const actionToken = separator === -1 ? trimmed : trimmed.slice(0, separator);
      const rawOptions = separator === -1 ? "" : trimmed.slice(separator).trim();
      const action = (actionToken || "status").toLowerCase();
      const options = rawOptions
        .split(/\s+/)
        .filter(Boolean)
        .map((value) => value.toLowerCase());
      if (action === "integrations") {
        ctx.ui.notify(
          formatIntegrationReport(integrationStatuses),
          integrationLevel(integrationStatuses),
        );
        return;
      }
      if (action === "catalog") {
        const definitions = await activeRuntime.catalog.listAvailable(activeRoot);
        ctx.ui.notify(
          definitions.map((definition) => `${definition.id} — ${definition.title}`).join("\n"),
          "info",
        );
        return;
      }
      if (action === "logs") {
        const logsAction = parseLogsCommand(rawOptions);
        if (!logsAction) {
          ctx.ui.notify(`Usage: ${PHENIX_LOGS_USAGE}`, "warning");
          return;
        }
        try {
          if (logsAction.kind === "resolve") {
            ctx.ui.notify(
              limit(await activeRuntime.diagnostics.resolve(activeRoot, logsAction.reference)),
              "info",
            );
            return;
          }
          const entries = await activeRuntime.diagnostics.entries(
            activeRoot,
            logsAction.minimum,
            logsAction.kind === "show" ? 200 : undefined,
          );
          if (logsAction.kind === "show") {
            ctx.ui.notify(
              limit(
                logsAction.json
                  ? JSON.stringify(entries, null, 2)
                  : formatDiagnosticEntries(entries),
              ),
              logsAction.minimum === "error" ? "warning" : "info",
            );
            return;
          }
          const exported = await activeRuntime.diagnostics.export(activeRoot, logsAction.minimum);
          if (logsAction.kind === "copy") {
            await copyFactHistory(exported, logsAction.command, ctx.cwd);
            ctx.ui.notify(
              `Copied ${entries.length} ${logsAction.minimum}+ diagnostic entries using: ${logsAction.command}`,
              "info",
            );
            return;
          }
          const file = await writeFactHistory(exported, logsAction.file, ctx.cwd);
          ctx.ui.notify(
            `Wrote ${entries.length} ${logsAction.minimum}+ diagnostic entries to ${file}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`Diagnostic log command failed: ${errorMessage(error)}`, "warning");
        }
        return;
      }
      if (action === "facts") {
        const activeMonitor =
          monitor ??
          new RunMonitor(ctx, activeRuntime, activeRoot, {
            integrations: summarizeIntegrations(integrationStatuses),
            integrationsFailed: integrationStatuses.some((status) => status.state === "failed"),
          });
        monitor = activeMonitor;
        const factsAction = parseFactsCommand(rawOptions);
        if (!factsAction) {
          ctx.ui.notify(`Usage: ${PHENIX_FACTS_USAGE}`, "warning");
          return;
        }
        if (factsAction.kind === "live") {
          await activeMonitor.show("facts");
          return;
        }
        if (factsAction.kind === "off") {
          activeMonitor.hide();
          return;
        }
        if (factsAction.kind === "once") {
          ctx.ui.notify(limit(await activeMonitor.once("facts")), "info");
          return;
        }
        if (factsAction.kind === "json") {
          ctx.ui.notify(limit(await activeMonitor.json("facts")), "info");
          return;
        }
        try {
          const exported = await activeMonitor.exportFacts();
          if (factsAction.kind === "clipboard") {
            await copyFactHistory(exported.text, factsAction.command, ctx.cwd);
            ctx.ui.notify(`Copied ${exported.count} facts using: ${factsAction.command}`, "info");
            return;
          }
          const file = await writeFactHistory(exported.text, factsAction.file, ctx.cwd);
          ctx.ui.notify(`Wrote ${exported.count} facts to ${file}`, "info");
        } catch (error) {
          ctx.ui.notify(`Fact export failed: ${errorMessage(error)}`, "warning");
        }
        return;
      }
      if (action === "tasks") {
        const tree = await activeRuntime.tasks.tree(activeRoot);
        ctx.ui.notify(limit(JSON.stringify(tree, null, 2)), "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify(`Usage: ${PHENIX_USAGE}`, "warning");
        return;
      }
      const activeMonitor =
        monitor ??
        new RunMonitor(ctx, activeRuntime, activeRoot, {
          integrations: summarizeIntegrations(integrationStatuses),
          integrationsFailed: integrationStatuses.some((status) => status.state === "failed"),
        });
      monitor = activeMonitor;
      const allowed = new Set(["off", "--once", "--json", "--expanded"]);
      if (
        options.some((option) => !allowed.has(option)) ||
        options.filter((option) => option !== "--expanded").length > 1
      ) {
        ctx.ui.notify(`Usage: ${PHENIX_STATUS_USAGE}`, "warning");
        return;
      }
      const expanded = options.includes("--expanded");
      if (options.includes("off")) {
        activeMonitor.hide();
        return;
      }
      if (options.includes("--once")) {
        ctx.ui.notify(limit(await activeMonitor.once("status", { expanded })), "info");
        return;
      }
      if (options.includes("--json")) {
        ctx.ui.notify(limit(await activeMonitor.json("status")), "info");
        return;
      }
      await activeMonitor.show("status", { expanded });
    },
  });
}

function registerAgentTool(
  pi: ExtensionAPI,
  tool: AgentTool,
  resolve: () => Promise<AgentTool> = async () => tool,
): void {
  pi.registerTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: tool.parameters.jsonSchema,
    async execute(_toolCallId, input, signal) {
      const activeTool = await resolve();
      const result = await activeTool.execute(input, signal);
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  } as ToolDefinition);
}

function findRootBinding(ctx: ExtensionContext, sessionId: string): RootBinding | undefined {
  const entries = [...ctx.sessionManager.getBranch()].reverse();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ROOT_BINDING_ENTRY) continue;
    const data = entry.data as Partial<RootBinding> | undefined;
    if (
      data?.sessionId === sessionId &&
      typeof data.rootRunId === "string" &&
      typeof data.lastSequence === "number"
    ) {
      return data as RootBinding;
    }
  }
  return undefined;
}

function appendBinding(
  pi: ExtensionAPI,
  runtime: PhenixRuntime,
  rootRunId: RunId,
  sessionId: string,
): void {
  pi.appendEntry(ROOT_BINDING_ENTRY, {
    sessionId,
    rootRunId,
    lastSequence: runtime.sequence(rootRunId),
  } satisfies RootBinding);
}

async function updateStatus(
  ctx: ExtensionContext,
  runtime: PhenixRuntime,
  rootRunId: RunId,
): Promise<void> {
  const [active, profile] = await Promise.all([
    runtime.queries.activeRuns(rootRunId),
    runtime.profiles.current(rootRunId),
  ]);
  const descendants = active.filter((run) => run.id !== rootRunId);
  ctx.ui.setStatus(STATUS_KEY, statusLine(ctx.ui.theme, profile, descendants.length));
}

async function applyAgentTools(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  preset: SessionAgentPreset,
): Promise<void> {
  const orchestrationTools = [
    "read",
    "grep",
    "find",
    "ls",
    "phenix_dispatch",
    "phenix_handle",
    "phenix_tasks",
  ] as const;
  const policies: Readonly<Record<SessionAgentPreset, readonly string[]>> = {
    base: orchestrationTools,
    scout: orchestrationTools,
    planner: orchestrationTools,
    architect: orchestrationTools,
    implementer: orchestrationTools,
    tester: orchestrationTools,
    verifier: orchestrationTools,
    critic: orchestrationTools,
    finalizer: orchestrationTools,
  };
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const tools = policies[preset].filter((tool) => available.has(tool));
  pi.setActiveTools(tools);
  const missing = policies[preset].filter((tool) => !available.has(tool));
  if (missing.length > 0) {
    ctx.ui.notify(`Agent ${preset}: unavailable tools: ${missing.join(", ")}`, "warning");
  }
}

function agentInstructions(preset: SessionAgentPreset): string {
  const instructions: Readonly<Record<SessionAgentPreset, string>> = {
    base: "Act as the read-only frontend coordinator. Answer simple read-only requests directly and route all substantial execution through phenix_dispatch.",
    scout:
      "Act as a read-only repository scout. Answer focused questions with concrete paths and evidence.",
    planner:
      "Act as a read-only planner. Produce executable steps and delegate only narrow evidence gaps.",
    architect:
      "Act as a read-only architect. Focus on ownership, boundaries, dependency direction, and replaceability.",
    implementer:
      "Act as an implementation-routing frontend. Use phenix_dispatch with mode=implement; do not mutate the repository directly.",
    tester:
      "Act as a QA-routing frontend. Use phenix_dispatch with mode=qa for repository-level checks and reviews.",
    verifier:
      "Act as a verification-routing frontend. Use phenix_dispatch with mode=qa for substantial repository verification.",
    critic:
      "Act as a read-only critic. Find contradictions, omissions, and unsafe assumptions, ranked by impact.",
    finalizer:
      "Act as a finalizer. Synthesize completed evidence and outcomes without starting new work.",
  };
  return instructions[preset];
}

function isDifficulty(value: string): value is SessionProfile["difficulty"] {
  return ["D0", "D1", "D2", "D3"].includes(value);
}

function thinkingForDifficulty(difficulty: SessionProfile["difficulty"]) {
  return difficulty === "D0"
    ? "minimal"
    : difficulty === "D1"
      ? "low"
      : difficulty === "D2"
        ? "high"
        : "xhigh";
}

function integrationLevel(statuses: readonly IntegrationStatus[]): "info" | "warning" {
  return statuses.some((status) => status.state === "failed") ? "warning" : "info";
}

function requireRuntime(runtime: PhenixRuntime | undefined, root: RunId | undefined) {
  if (!runtime || !root) throw new Error(`Phenix runtime is not initialized`);
  return { runtime, root };
}

function concreteModel(provider: string, model: string) {
  return { kind: "concrete" as const, provider, model };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function limit(value: string): string {
  return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n… truncated`;
}
