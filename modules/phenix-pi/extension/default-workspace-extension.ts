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
import { interruptActiveRootWork } from "./workspace/interrupt-active-work.ts";
import { handoffNativeWorkspaceInput } from "./workspace/native-input-handoff.ts";
import { renderWorkspaceTurn } from "./workspace/turn-indicator.ts";
import {
  type NativeInputDelegation,
  WORKSPACE_NATIVE_HANDOFF,
} from "./workspace/workspace-interaction.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

const TURN_STATUS_KEY = "phenix-turn";

type WorkspaceCompletion = PhenixWorkspaceAction & {
  readonly reopenWorkspace?: boolean;
};

export default function defaultWorkspaceExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let workspace: PhenixWorkspace | undefined;
  let finish: ((action: WorkspaceCompletion) => void) | undefined;
  let opening = false;
  let rootTurnActive = false;
  let turnRevision = 0;
  let disposeTurnEvents: (() => void) | undefined;

  const requestOpen = (): void => {
    if (opening || workspace || context?.mode !== "tui" || !binding) return;
    void openWorkspaceLoop();
  };

  const refreshTurn = (): void => {
    void updateTurnIndicator();
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    disposeTurnEvents?.();
    disposeTurnEvents = undefined;
    binding = next;
    if (!next) {
      context?.ui.setStatus(TURN_STATUS_KEY, undefined);
      finish?.({ kind: "close" });
      return;
    }
    disposeTurnEvents = next.runtime.events.subscribe(refreshTurn);
    refreshTurn();
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
      refreshTurn();
      requestOpen();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    rootTurnActive = false;
    refreshTurn();
    requestOpen();
  });

  pi.on("agent_start", () => {
    rootTurnActive = true;
    refreshTurn();
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

  pi.on("agent_end", () => {
    rootTurnActive = false;
    refreshTurn();
  });

  pi.on("session_shutdown", () => {
    context?.ui.setStatus(TURN_STATUS_KEY, undefined);
    disposeTurnEvents?.();
    disposeTurnEvents = undefined;
    finish?.({ kind: "close" });
    workspace = undefined;
    context = undefined;
    binding = undefined;
    rootTurnActive = false;
  });

  async function updateTurnIndicator(): Promise<void> {
    const ctx = context;
    const active = binding;
    const revision = ++turnRevision;
    if (!ctx || !active) {
      ctx?.ui.setStatus(TURN_STATUS_KEY, undefined);
      return;
    }
    try {
      const descendants = (await active.runtime.queries.activeRuns(active.rootRunId)).filter(
        (run) => run.id !== active.rootRunId,
      ).length;
      if (revision !== turnRevision || context !== ctx || binding !== active) return;
      ctx.ui.setStatus(
        TURN_STATUS_KEY,
        renderWorkspaceTurn(ctx.ui.theme, {
          rootActive: rootTurnActive,
          activeDescendants: descendants,
        }),
      );
    } catch {
      if (revision === turnRevision && context === ctx) {
        ctx.ui.setStatus(TURN_STATUS_KEY, undefined);
      }
    }
  }

  async function openWorkspaceLoop(): Promise<void> {
    const ctx = context;
    const active = binding;
    if (!ctx || !active || ctx.mode !== "tui" || opening || workspace) return;
    opening = true;
    try {
      let reopen = true;
      while (reopen && context === ctx && binding?.rootRunId === active.rootRunId) {
        const action = await openWorkspace(
          pi,
          ctx,
          active,
          (instance, done) => {
            workspace = instance;
            finish = done;
          },
          {
            onSubmitStarted: () => {
              rootTurnActive = true;
              refreshTurn();
            },
            onSubmitFailed: () => {
              rootTurnActive = false;
              refreshTurn();
            },
          },
        );
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

interface WorkspaceLifecycleCallbacks {
  readonly onSubmitStarted: () => void;
  readonly onSubmitFailed: () => void;
}

async function openWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  ready: (workspace: PhenixWorkspace, done: (action: WorkspaceCompletion) => void) => void,
  lifecycle: WorkspaceLifecycleCallbacks,
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
        if (delegation.action === "app.interrupt") {
          void interruptActiveRootWork(binding.runtime, binding.rootRunId)
            .then((targets) => {
              if (targets.length > 0) {
                ctx.ui.notify(
                  `Interrupted current task and ${targets.length} attached run${targets.length === 1 ? "" : "s"}.`,
                  "warning",
                );
              }
            })
            .catch((error) => {
              ctx.ui.notify(
                `Unable to interrupt Phenix work: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            });
        }
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
          loadTranscript: (node) =>
            loadNativeRunTranscriptResult(
              node,
              tui,
              theme,
              binding.runtime.transcripts.get(node.run.id),
              ctx.cwd,
            ),
          subscribe: (listener) => {
            const unsubscribeEvents = binding.runtime.events.subscribe(listener);
            const unsubscribeDiagnostics = binding.runtime.diagnostics.subscribe(listener);
            const unsubscribeTranscripts = binding.runtime.transcripts.subscribe(() => listener());
            return () => {
              unsubscribeEvents();
              unsubscribeDiagnostics();
              unsubscribeTranscripts();
            };
          },
          submit: async (text) => {
            lifecycle.onSubmitStarted();
            try {
              await Promise.resolve(
                pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" }),
              );
            } catch (error) {
              lifecycle.onSubmitFailed();
              throw error;
            }
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
        loadTranscript: (node) =>
          loadNativeRunTranscript(
            node,
            tui,
            theme,
            binding.runtime.transcripts.get(node.run.id),
            ctx.cwd,
          ),
        subscribe: (listener) => {
          const unsubscribeEvents = binding.runtime.events.subscribe(listener);
          const unsubscribeDiagnostics = binding.runtime.diagnostics.subscribe(listener);
          const unsubscribeTranscripts = binding.runtime.transcripts.subscribe(() => listener());
          return () => {
            unsubscribeEvents();
            unsubscribeDiagnostics();
            unsubscribeTranscripts();
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
