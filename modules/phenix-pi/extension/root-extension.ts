import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createPhenixRuntime, type PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { ConcreteModelRef } from "../domain/definition/model.ts";
import { type RunId, runId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";

const ROOT_BINDING_ENTRY = "phenix:root-binding";
const STATUS_KEY = "phenix";

interface RootBinding {
  readonly sessionId: string;
  readonly rootRunId: RunId;
  readonly lastSequence: number;
}

export default function phenixRootExtension(pi: ExtensionAPI): void {
  let runtime: PhenixRuntime | undefined;
  let rootRunId: RunId | undefined;
  let toolsRegistered = false;
  let disposeStatus: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const previousRuntime = runtime;
    const previousRoot = rootRunId;
    runtime = undefined;
    rootRunId = undefined;
    disposeStatus?.();
    disposeStatus = undefined;
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
      ...(ctx.model ? { model: concreteModel(ctx.model.provider, ctx.model.id) } : {}),
    });

    if (!toolsRegistered) {
      for (const tool of await currentRuntime.rootTools(currentRoot)) {
        registerAgentTool(pi, tool, async () => {
          const activeRuntime = runtime;
          const activeRoot = rootRunId;
          if (!activeRuntime || !activeRoot) {
            throw new Error(`Phenix runtime is not initialized`);
          }
          const activeTool = (await activeRuntime.rootTools(activeRoot)).find(
            (candidate) => candidate.name === tool.name,
          );
          if (!activeTool) throw new Error(`Phenix tool ${tool.name} is unavailable`);
          return activeTool;
        });
      }
      toolsRegistered = true;
    }
    disposeStatus = currentRuntime.events.subscribe(() =>
      updateStatus(ctx, currentRuntime, currentRoot),
    );
    await updateStatus(ctx, currentRuntime, currentRoot);
    appendBinding(pi, currentRuntime, currentRoot, sessionId);
  });

  pi.on("before_agent_start", async (event) => {
    if (!runtime || !rootRunId) return;
    const [available, active] = await Promise.all([
      runtime.catalog.listAvailable(rootRunId),
      runtime.queries.activeRuns(rootRunId),
    ]);
    const capabilities = available.map((definition) => definition.id).join(", ");
    const handles = active
      .filter((run) => run.id !== rootRunId)
      .map((run) => `${run.id}:${run.state}`)
      .join(", ");
    return {
      systemPrompt: `${event.systemPrompt}\n\nPhenix execution scope:\n- Invoke typed work through phenix_run; definitions own their internal actors, transitions, and models.\n- Available definitions: ${capabilities || "none"}.\n- Active descendant handles: ${handles || "none"}.\n- A background child remains attached. Use phenix_handle to inspect, await, send, or cancel it.\n- Use phenix_tasks only for local leaves; execution anchors are derived and read-only.`,
    };
  });

  pi.on("input", async (event) => {
    if (!runtime || !rootRunId || event.source === "extension") return;
    await runtime.amendRootInput(rootRunId, event.text);
  });

  pi.on("model_select", async (event) => {
    if (!runtime || !rootRunId) return;
    await runtime.observeRootModel(rootRunId, concreteModel(event.model.provider, event.model.id));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const currentRuntime = runtime;
    const currentRoot = rootRunId;
    runtime = undefined;
    rootRunId = undefined;
    disposeStatus?.();
    disposeStatus = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (!currentRuntime || !currentRoot) return;
    await currentRuntime.shutdown(currentRoot);
    appendBinding(pi, currentRuntime, currentRoot, ctx.sessionManager.getSessionId());
  });

  pi.registerCommand("phenix", {
    description: "Inspect Phenix; usage: /phenix status|runs|tasks|catalog",
    handler: async (args, ctx) => {
      if (!runtime || !rootRunId) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      const action = args.trim().toLowerCase() || "status";
      if (action === "catalog") {
        const definitions = await runtime.catalog.listAvailable(rootRunId);
        ctx.ui.notify(
          definitions.map((definition) => `${definition.id} — ${definition.title}`).join("\n"),
          "info",
        );
        return;
      }
      if (action === "runs") {
        const tree = await runtime.queries.runTree(rootRunId);
        ctx.ui.notify(limit(JSON.stringify(tree, null, 2)), "info");
        return;
      }
      if (action === "tasks") {
        const tree = await runtime.tasks.tree(rootRunId);
        ctx.ui.notify(limit(JSON.stringify(tree, null, 2)), "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /phenix status|runs|tasks|catalog", "warning");
        return;
      }
      const active = await runtime.queries.activeRuns(rootRunId);
      const descendants = active.filter((run) => run.id !== rootRunId);
      const ledger = runtime.ledgerPath(rootRunId) ?? "in-memory";
      ctx.ui.notify(
        `Root: ${rootRunId}\nSequence: ${runtime.sequence(rootRunId)}\nActive descendants: ${descendants.length}\nLedger: ${ledger}`,
        "info",
      );
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
  const active = await runtime.queries.activeRuns(rootRunId);
  const descendants = active.filter((run) => run.id !== rootRunId);
  ctx.ui.setStatus(
    STATUS_KEY,
    descendants.length === 0 ? "phenix: idle" : `phenix: ${descendants.length} active`,
  );
}

function concreteModel(provider: string, model: string): ConcreteModelRef {
  return { kind: "concrete", provider, model };
}

function limit(value: string): string {
  return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\n… truncated`;
}
