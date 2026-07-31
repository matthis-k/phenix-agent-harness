import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "@earendil-works/pi-tui";

import { projectWorkspaceAttention } from "../application/workspace/project-attention.ts";
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
import { openUserFormInbox } from "./user-form-extension.ts";
import { interruptActiveRootWork } from "./workspace/interrupt-active-work.ts";
import { handoffNativeWorkspaceInput } from "./workspace/native-input-handoff.ts";
import { renderWorkspaceTurn } from "./workspace/turn-indicator.ts";
import { selectedWorkspaceInputTarget } from "./workspace/workspace-controller-adapter.ts";
import {
  type NativeInputDelegation,
  WORKSPACE_NATIVE_HANDOFF,
} from "./workspace/workspace-interaction.ts";
import { routeWorkspaceMessage } from "./workspace/workspace-message-routing.ts";
import {
  WorkspaceSelectDialog,
  type WorkspaceSelectDialogItem,
} from "./workspace/workspace-select-dialog.ts";
import {
  subscribeWorkspaceChanges,
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

const TURN_STATUS_KEY = "phenix-turn";

type WorkspaceCompletion = PhenixWorkspaceAction & {
  readonly reopenWorkspace?: boolean;
};

interface WorkspaceModelChoice {
  readonly provider: string;
  readonly modelId: string;
}

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
  let nativeDialogActive = false;

  const showModelDialog = async (): Promise<void> => {
    if (nativeDialogActive) return;
    nativeDialogActive = true;
    try {
      await openWorkspaceModelDialog(pi, ctx);
    } finally {
      nativeDialogActive = false;
    }
  };

  const showUserFormInbox = async (): Promise<void> => {
    if (nativeDialogActive) return;
    nativeDialogActive = true;
    try {
      await openUserFormInbox(ctx, binding);
    } finally {
      nativeDialogActive = false;
    }
  };

  const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
    if (!activeWorkspace || !activeKeybindings || nativeDialogActive) return undefined;
    return handoffNativeWorkspaceInput({
      data,
      keybindings: activeKeybindings,
      handoff: (delegation) => {
        if (delegation.action === "app.model.select") {
          void showModelDialog().catch((error) => {
            notifyWorkspaceCommandError(ctx, "model selector", error);
          });
          return "consume";
        }

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
        return "forward";
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
          if (action.kind === "native" && slashCommandName(action.text) === "model") {
            void showModelDialog().catch((error) => {
              notifyWorkspaceCommandError(ctx, "model selector", error);
            });
            return;
          }
          if (action.kind === "native" && slashCommandName(action.text) === "userforms") {
            void showUserFormInbox().catch((error) => {
              notifyWorkspaceCommandError(ctx, "user form inbox", error);
            });
            return;
          }
          if (action.kind === "native" && isRegisteredWorkspaceCommand(action.text, commands)) {
            void executeWorkspaceCommand(pi, ctx, action.text).catch((error) => {
              notifyWorkspaceCommandError(ctx, action.text, error);
            });
            return;
          }

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
          subscribe: (listener) => subscribeWorkspaceChanges(binding.runtime, listener),
          submit: async (text) => {
            const targetRunId = selectedWorkspaceInputTarget(binding.rootRunId);
            const targetsRoot = targetRunId === binding.rootRunId;
            if (targetsRoot) lifecycle.onSubmitStarted();
            try {
              await routeWorkspaceMessage({
                runtime: binding.runtime,
                rootRunId: binding.rootRunId,
                targetRunId,
                text,
                sendRoot: (message) =>
                  Promise.resolve(
                    pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "steer" }),
                  ),
              });
            } catch (error) {
              if (targetsRoot) lifecycle.onSubmitFailed();
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

async function openWorkspaceModelDialog(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const models = await ctx.modelRegistry.getAvailable();
  const items: WorkspaceSelectDialogItem<WorkspaceModelChoice>[] = models.map((model) => {
    const id = `${model.provider}/${model.id}`;
    return {
      id,
      label: model.name || model.id,
      detail: id,
      searchText: `${model.provider} ${model.id} ${model.name ?? ""}`,
      current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
      value: { provider: model.provider, modelId: model.id },
    };
  });
  items.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return left.label.localeCompare(right.label);
  });

  const selection = await ctx.ui.custom<WorkspaceModelChoice | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceSelectDialog({
        tui,
        theme,
        keybindings,
        title: "Select model",
        items,
        emptyMessage: "No available models",
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "72%",
        maxHeight: "75%",
        anchor: "center",
        margin: 1,
      },
    },
  );
  if (!selection) return;

  const model = ctx.modelRegistry.find(selection.provider, selection.modelId);
  if (!model) {
    ctx.ui.notify(
      `Model ${selection.provider}/${selection.modelId} is no longer available.`,
      "warning",
    );
    return;
  }
  if (!(await pi.setModel(model))) {
    ctx.ui.notify(
      `No configured authentication for ${selection.provider}/${selection.modelId}.`,
      "error",
    );
  }
}

async function executeWorkspaceCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  text: string,
): Promise<void> {
  await Promise.resolve(
    pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" }),
  );
}

function isRegisteredWorkspaceCommand(text: string, commands: readonly SlashCommand[]): boolean {
  const name = slashCommandName(text);
  return name !== undefined && commands.some((command) => command.name === name);
}

function slashCommandName(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [name] = trimmed.slice(1).split(/\s+/, 1);
  return name || undefined;
}

function notifyWorkspaceCommandError(ctx: ExtensionContext, command: string, error: unknown): void {
  ctx.ui.notify(
    `Unable to run ${command}: ${error instanceof Error ? error.message : String(error)}`,
    "warning",
  );
}

async function loadWorkspaceSnapshot(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  tui: Parameters<typeof renderNativeTranscript>[1],
  theme: ObservabilityTheme,
): Promise<PhenixWorkspaceSnapshot> {
  const [ui, tasks, projects] = await Promise.all([
    loadPhenixUiSnapshot(binding.runtime, binding.rootRunId, binding.integrations),
    binding.runtime.tasks.tree(binding.rootRunId),
    binding.runtime.projects.list(),
  ]);
  const entries = buildContextEntries([...ctx.sessionManager.getBranch()]);
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    ui,
    tasks,
    attentionByRun: projectWorkspaceAttention(projects),
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
        subscribe: (listener) => subscribeWorkspaceChanges(binding.runtime, listener),
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
