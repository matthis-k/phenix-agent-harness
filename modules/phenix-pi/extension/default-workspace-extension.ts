import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import {
  loadNativeRunTranscript,
  presentNativeRunTranscript,
  readyNativeRunTranscript,
  renderNativeTranscript,
} from "./native-run-transcript.ts";
import { loadPhenixUiSnapshot, PhenixUi, type PhenixUiTarget } from "./phenix-ui.ts";
import {
  PhenixWorkspace,
  type PhenixWorkspaceAction,
  type PhenixWorkspaceOptions,
  type PhenixWorkspaceSnapshot,
} from "./phenix-workspace.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

export default function defaultWorkspaceExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let workspace: PhenixWorkspace | undefined;
  let finish: ((action: PhenixWorkspaceAction) => void) | undefined;
  let opening = false;

  const requestOpen = (): void => {
    if (opening || workspace || context?.mode !== "tui" || !binding) return;
    void openWorkspaceLoop();
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    binding = next;
    if (!next) {
      finish?.({ kind: "close" });
      return;
    }
    requestOpen();
  });

  pi.registerCommand("workspace", {
    description: "Open the default Phenix transcript and status workspace",
    handler: async (_args, ctx) => {
      context = ctx;
      if (!binding) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      requestOpen();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    requestOpen();
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") {
      workspace?.setStreamingMessage(event.message as Extract<AgentMessage, { role: "assistant" }>);
    }
  });

  pi.on("message_end", () => {
    workspace?.setStreamingMessage(undefined);
    workspace?.refreshRootTranscript();
  });

  pi.on("session_shutdown", () => {
    finish?.({ kind: "close" });
    workspace = undefined;
    context = undefined;
    binding = undefined;
  });

  async function openWorkspaceLoop(): Promise<void> {
    const ctx = context;
    const active = binding;
    if (!ctx || !active || ctx.mode !== "tui" || opening || workspace) return;
    opening = true;
    try {
      let reopen = true;
      while (reopen && context === ctx && binding?.rootRunId === active.rootRunId) {
        const action = await openWorkspace(pi, ctx, active, (instance, done) => {
          workspace = instance;
          finish = done;
        });
        workspace = undefined;
        finish = undefined;
        if (action.kind === "inspector") {
          await openInspector(ctx, active, action.target);
          continue;
        }
        if (action.kind === "native") {
          ctx.ui.setEditorText(action.text);
        }
        reopen = false;
      }
    } finally {
      opening = false;
    }
  }
}

async function openWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  ready: (workspace: PhenixWorkspace, done: (action: PhenixWorkspaceAction) => void) => void,
): Promise<PhenixWorkspaceAction> {
  return ctx.ui.custom(
    async (tui, theme, keybindings, done) => {
      const load = () => loadWorkspaceSnapshot(ctx, binding, tui);
      const snapshot = await load();
      const commands: SlashCommand[] = pi.getCommands().map((command) => ({
        name: command.name,
        description: command.description,
      }));
      const loadTranscript = ((node: RunTreeNode) =>
        loadNativeRunTranscript(node, tui)) as unknown as PhenixWorkspaceOptions["loadTranscript"];
      const instance = new PhenixWorkspace({
        tui,
        theme,
        keybindings,
        cwd: ctx.cwd,
        commands,
        snapshot,
        load,
        loadTranscript,
        subscribe: (listener) => {
          const unsubscribeEvents = binding.runtime.events.subscribe(listener);
          const unsubscribeDiagnostics = binding.runtime.diagnostics.subscribe(listener);
          return () => {
            unsubscribeEvents();
            unsubscribeDiagnostics();
          };
        },
        submit: async (text) => {
          await Promise.resolve(
            pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" }),
          );
        },
        onAction: done,
      });
      ready(instance, done);
      return instance;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    },
  );
}

async function loadWorkspaceSnapshot(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  tui: Parameters<typeof renderNativeTranscript>[1],
): Promise<PhenixWorkspaceSnapshot> {
  const [ui, tasks] = await Promise.all([
    loadPhenixUiSnapshot(binding.runtime, binding.rootRunId, binding.integrations),
    binding.runtime.tasks.tree(binding.rootRunId),
  ]);
  const entries = buildContextEntries([...ctx.sessionManager.getBranch()]);
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    ui,
    tasks,
    rootTranscript: readyNativeRunTranscript({
      component: renderNativeTranscript(entries, tui, ctx.cwd),
      sessionId,
      ...(sessionFile ? { sessionFile } : {}),
    }),
  };
}

async function openInspector(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  initial: PhenixUiTarget,
): Promise<void> {
  const load = () => loadPhenixUiSnapshot(binding.runtime, binding.rootRunId, binding.integrations);
  const snapshot = await load();
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new PhenixUi({
        tui,
        theme,
        initial,
        snapshot,
        load,
        loadTranscript: async (node: RunTreeNode) =>
          presentNativeRunTranscript(await loadNativeRunTranscript(node, tui), node),
        subscribe: (listener) => {
          const unsubscribeEvents = binding.runtime.events.subscribe(listener);
          const unsubscribeDiagnostics = binding.runtime.diagnostics.subscribe(listener);
          return () => {
            unsubscribeEvents();
            unsubscribeDiagnostics();
          };
        },
        onClose: () => done(undefined),
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    },
  );
}
