import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "@earendil-works/pi-tui";

import {
  loadNativeRunTranscript,
  loadNativeRunTranscriptResult,
  readyNativeRunTranscript,
  renderNativeTranscript,
} from "./native-run-transcript.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";
import { loadPhenixUiSnapshot, PhenixUi, type PhenixUiTarget } from "./phenix-ui.ts";
import {
  PhenixWorkspace,
  type PhenixWorkspaceAction,
  type PhenixWorkspaceSnapshot,
} from "./phenix-workspace.ts";
import { handoffNativeWorkspaceInput } from "./workspace/native-input-handoff.ts";
import {
  type NativeInputDelegation,
  WORKSPACE_NATIVE_HANDOFF,
} from "./workspace/workspace-interaction.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

type WorkspaceCompletion = PhenixWorkspaceAction & {
  readonly reopenWorkspace?: boolean;
};

export default function defaultWorkspaceExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let workspace: PhenixWorkspace | undefined;
  let finish: ((action: WorkspaceCompletion) => void) | undefined;
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
          reopen = action.reopenWorkspace === true;
          continue;
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
  ready: (workspace: PhenixWorkspace, done: (action: WorkspaceCompletion) => void) => void,
): Promise<WorkspaceCompletion> {
  let activeWorkspace: PhenixWorkspace | undefined;
  let activeKeybindings: KeybindingsManager | undefined;
  let pendingDelegation: NativeInputDelegation | undefined;
  const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
    if (!activeWorkspace || !activeKeybindings) return undefined;
    return handoffNativeWorkspaceInput({
      data,
      keybindings: activeKeybindings,
      handoff: (delegation) => {
        pendingDelegation = delegation;
        activeWorkspace?.handleInput(WORKSPACE_NATIVE_HANDOFF);
        pendingDelegation = undefined;
      },
    });
  });

  try {
    return await ctx.ui.custom<WorkspaceCompletion>(
      async (tui, theme, keybindings, done) => {
        const load = () => loadWorkspaceSnapshot(ctx, binding, tui, theme);
        const snapshot = await load();
        const commands: SlashCommand[] = pi.getCommands().map((command) => ({
          name: command.name,
          description: command.description,
        }));
        const complete = (action: PhenixWorkspaceAction): void => {
          const delegation = action.kind === "native" ? pendingDelegation : undefined;
          if (action.kind === "native" && delegation) {
            ctx.ui.setEditorText(action.text);
            activeWorkspace = undefined;
            activeKeybindings = undefined;
            done({
              ...action,
              reopenWorkspace: delegation.reopenWorkspace,
            });
            return;
          }
          activeWorkspace = undefined;
          activeKeybindings = undefined;
          done(action);
        };
        const instance = new PhenixWorkspace({
          tui,
          theme,
          keybindings,
          cwd: ctx.cwd,
          commands,
          snapshot,
          load,
          loadTranscript: (node) => loadNativeRunTranscriptResult(node, tui, theme),
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
          onAction: complete,
        });
        activeWorkspace = instance;
        activeKeybindings = keybindings;
        ready(instance, complete);
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
  } finally {
    unsubscribeInput();
  }
}

async function loadWorkspaceSnapshot(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  tui: Parameters<typeof renderNativeTranscript>[1],
  theme: ObservabilityTheme,
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
      component: renderNativeTranscript(entries, tui, ctx.cwd, theme),
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
        loadTranscript: (node) => loadNativeRunTranscript(node, tui, theme),
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
