import type { ImageContent, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionRuntime,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { type RunId, runId } from "../domain/shared.ts";
import { loadPhenixUiSnapshot } from "../extension/phenix-ui.ts";
import { routeWorkspaceMessage } from "../extension/workspace/workspace-message-routing.ts";
import type { WorkspaceRuntimeBinding } from "../extension/workspace-runtime-binding.ts";
import type { HeadlessAuthCoordinator } from "./auth-coordinator.ts";
import type {
  HeadlessAuthPort,
  HeadlessExecutionPort,
  HeadlessExecutorDependencies,
  HeadlessExtensionUiPort,
  HeadlessLifecyclePort,
  HeadlessModelPort,
  HeadlessResourcePort,
  HeadlessSessionPort,
} from "./executor.ts";
import { HeadlessRuntimeExecutor } from "./executor.ts";
import type { HeadlessExtensionUi } from "./extension-ui.ts";
import type {
  HeadlessCommand,
  HeadlessImage,
  HeadlessModelRef,
  HeadlessThinkingLevel,
} from "./protocol.ts";
import { HeadlessCommandError } from "./server.ts";

export interface PiHeadlessWorkspaceAccess {
  current(): WorkspaceRuntimeBinding | undefined;
  changed(listener: () => void): () => void;
}

export interface PiHeadlessAdapterOptions {
  readonly runtimeHost: AgentSessionRuntime;
  readonly workspace: PiHeadlessWorkspaceAccess;
  readonly auth: HeadlessAuthCoordinator;
  readonly extensionUi: HeadlessExtensionUi;
  readonly rebindSession: () => Promise<void>;
  readonly publish: (event: unknown) => void | Promise<void>;
  readonly requestShutdown: () => void;
}

type Command<T extends HeadlessCommand["type"]> = Extract<HeadlessCommand, { readonly type: T }>;

export function createPiHeadlessExecutor(
  options: PiHeadlessAdapterOptions,
): HeadlessRuntimeExecutor {
  const adapter = new PiHeadlessAdapter(options);
  return new HeadlessRuntimeExecutor(adapter.dependencies);
}

class PiHeadlessAdapter {
  readonly #runtimeHost: AgentSessionRuntime;
  readonly #workspace: PiHeadlessWorkspaceAccess;
  readonly #auth: HeadlessAuthCoordinator;
  readonly #extensionUi: HeadlessExtensionUi;
  readonly #rebindSession: () => Promise<void>;
  readonly #publish: (event: unknown) => void | Promise<void>;
  readonly #requestShutdown: () => void;
  readonly #unsubscribeWorkspace: () => void;
  #disposed = false;

  readonly dependencies: HeadlessExecutorDependencies;

  constructor(options: PiHeadlessAdapterOptions) {
    this.#runtimeHost = options.runtimeHost;
    this.#workspace = options.workspace;
    this.#auth = options.auth;
    this.#extensionUi = options.extensionUi;
    this.#rebindSession = options.rebindSession;
    this.#publish = options.publish;
    this.#requestShutdown = options.requestShutdown;
    this.#unsubscribeWorkspace = options.workspace.changed(() => {
      void this.publishSnapshotChanged();
    });

    const lifecycle: HeadlessLifecyclePort = {
      initialize: async () => ({
        capabilities: PI_HEADLESS_CAPABILITIES,
        snapshot: await this.snapshot(),
      }),
      shutdown: async () => {
        this.#requestShutdown();
        return { accepted: true };
      },
      dispose: async () => this.dispose(),
    };
    const execution: HeadlessExecutionPort = {
      snapshot: async () => this.snapshot(),
      submitPrompt: async (command) => this.submitPrompt(command),
      steerPrompt: async (command) => this.steerPrompt(command),
      followUpPrompt: async (command) => this.followUpPrompt(command),
      abort: async (command) => this.abort(command),
      startCompaction: async (command) => this.startCompaction(command),
      abortCompaction: async (command) => this.abortCompaction(command),
      configureRetry: async (command) => this.configureRetry(command),
      abortRetry: async (command) => this.abortRetry(command),
    };
    const sessions: HeadlessSessionPort = {
      create: async (command) => this.createSession(command),
      switch: async (command) => this.switchSession(command),
      fork: async (command) => this.forkSession(command),
      clone: async (command) => this.cloneSession(command),
      rename: async (command) => this.renameSession(command),
      list: async () => this.listSessions(),
      tree: async (command) => this.sessionTree(command),
      export: async (command) => this.exportSession(command),
    };
    const models: HeadlessModelPort = {
      list: async () => this.listModels(),
      select: async (command) => this.selectModel(command),
      thinkingLevels: async (command) => this.thinkingLevels(command),
      selectThinking: async (command) => this.selectThinking(command),
    };
    const auth: HeadlessAuthPort = {
      providers: async () => this.#auth.listProviders(),
      start: async (command) => ({
        flowId: this.#auth.start(command.providerId, command.method),
      }),
      respond: async (command) => {
        this.#auth.respond(command.flowId, command.response);
        return { accepted: true };
      },
      cancel: async (command) => {
        this.#auth.cancel(command.flowId);
        return { accepted: true };
      },
      logout: async (command) => {
        await this.#auth.logout(command.providerId);
        return { completed: true };
      },
    };
    const resources: HeadlessResourcePort = {
      commands: async () => this.listCommands(),
      invoke: async (command) => this.invokeCommand(command),
      reload: async () => {
        await this.session.reload();
        return { completed: true };
      },
    };
    const extensionUi: HeadlessExtensionUiPort = {
      respond: async (command) => {
        this.#extensionUi.respond(command.dialogId, command.response);
        return { accepted: true };
      },
    };
    this.dependencies = { lifecycle, execution, sessions, models, auth, resources, extensionUi };
  }

  private get session(): AgentSession {
    return this.#runtimeHost.session;
  }

  private binding(): WorkspaceRuntimeBinding {
    const binding = this.#workspace.current();
    if (!binding) {
      throw new HeadlessCommandError({
        code: "invalid_state",
        message: "Phenix workspace runtime is not initialized",
        retryable: true,
      });
    }
    return binding;
  }

  private async snapshot(): Promise<unknown> {
    const binding = this.binding();
    const workspace = await loadPhenixUiSnapshot(
      binding.runtime,
      binding.rootRunId,
      binding.integrations,
    );
    return {
      health: "ready",
      capabilities: PI_HEADLESS_CAPABILITIES,
      activeSession: sessionSummary(this.session),
      rootRunId: String(binding.rootRunId),
      selectedRunId: String(binding.rootRunId),
      workspace,
    };
  }

  private async publishSnapshotChanged(): Promise<void> {
    if (this.#disposed || !this.#workspace.current()) return;
    try {
      await this.#publish({ type: "snapshot.changed", snapshot: await this.snapshot() });
    } catch (error: unknown) {
      await this.#publish({
        type: "runtime.health",
        health: "degraded",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async submitPrompt(command: Command<"prompt.submit">): Promise<unknown> {
    return this.routeInput(command.runId, command.text, async () =>
      acceptedPrompt(this.session, command.text, command.images, command.streamingBehavior),
    );
  }

  private async steerPrompt(command: Command<"prompt.steer">): Promise<unknown> {
    return this.routeInput(command.runId, command.text, async () => {
      await this.session.steer(command.text, piImages(command.images));
      return { accepted: true, route: "root-steer" };
    });
  }

  private async followUpPrompt(command: Command<"prompt.follow_up">): Promise<unknown> {
    const binding = this.binding();
    if (command.runId !== String(binding.rootRunId)) {
      throw new HeadlessCommandError({
        code: "unsupported_command",
        message: "Follow-up queueing is currently available only for the root Pi session",
      });
    }
    await this.session.followUp(command.text, piImages(command.images));
    return { accepted: true, route: "root-follow-up" };
  }

  private async routeInput(
    target: string,
    text: string,
    sendRoot: () => Promise<unknown>,
  ): Promise<unknown> {
    const binding = this.binding();
    let rootResult: unknown;
    const route = await routeWorkspaceMessage({
      runtime: binding.runtime,
      rootRunId: binding.rootRunId,
      targetRunId: runId(target),
      text,
      sendRoot: async () => {
        rootResult = await sendRoot();
      },
    });
    return route.kind === "root" ? rootResult : route;
  }

  private async abort(command: Command<"execution.abort">): Promise<unknown> {
    const binding = this.binding();
    const target = command.runId ? runId(command.runId) : binding.rootRunId;
    if (target === binding.rootRunId) {
      await this.session.abort();
      return { completed: true, target: "root" };
    }
    await binding.runtime.execution.cancel(target, "Interrupted by the user from the Phenix UI");
    return { completed: true, target: String(target) };
  }

  private async startCompaction(command: Command<"compaction.start">): Promise<unknown> {
    this.requireRootRun(command.runId);
    return this.session.compact(command.instructions);
  }

  private async abortCompaction(command: Command<"compaction.abort">): Promise<unknown> {
    this.requireRootRun(command.runId);
    this.session.abortCompaction();
    return { completed: true };
  }

  private async configureRetry(command: Command<"retry.configure">): Promise<unknown> {
    this.requireRootRun(command.runId);
    this.session.setAutoRetryEnabled(command.enabled);
    return { completed: true };
  }

  private async abortRetry(command: Command<"retry.abort">): Promise<unknown> {
    this.requireRootRun(command.runId);
    this.session.abortRetry();
    return { completed: true };
  }

  private async createSession(command: Command<"session.create">): Promise<unknown> {
    const result = await this.#runtimeHost.newSession(
      command.parentSession ? { parentSession: command.parentSession } : undefined,
    );
    if (!result.cancelled) await this.#rebindSession();
    return result;
  }

  private async switchSession(command: Command<"session.switch">): Promise<unknown> {
    const info = await this.resolveSession(command.sessionId);
    const result = await this.#runtimeHost.switchSession(info.path);
    if (!result.cancelled) await this.#rebindSession();
    return result;
  }

  private async forkSession(command: Command<"session.fork">): Promise<unknown> {
    await this.ensureActiveSession(command.sessionId);
    const result = await this.#runtimeHost.fork(command.entryId);
    if (!result.cancelled) await this.#rebindSession();
    return { ...result, selectedText: result.selectedText };
  }

  private async cloneSession(command: Command<"session.clone">): Promise<unknown> {
    await this.ensureActiveSession(command.sessionId);
    const leafId = this.session.sessionManager.getLeafId();
    if (!leafId) {
      throw new HeadlessCommandError({
        code: "invalid_state",
        message: "Cannot clone a session without a selected entry",
      });
    }
    const result = await this.#runtimeHost.fork(leafId, { position: "at" });
    if (!result.cancelled) await this.#rebindSession();
    return result;
  }

  private async renameSession(command: Command<"session.rename">): Promise<unknown> {
    await this.ensureActiveSession(command.sessionId);
    this.session.setSessionName(command.name);
    return { completed: true };
  }

  private async listSessions(): Promise<unknown> {
    const manager = this.session.sessionManager;
    const sessions = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
    return sessions.map(persistedSessionSummary);
  }

  private async sessionTree(command: Command<"session.tree">): Promise<unknown> {
    await this.ensureActiveSession(command.sessionId);
    return {
      sessionId: this.session.sessionId,
      leafEntryId: this.session.sessionManager.getLeafId(),
      tree: this.session.sessionManager.getTree(),
    };
  }

  private async exportSession(command: Command<"session.export">): Promise<unknown> {
    await this.ensureActiveSession(command.sessionId);
    return { path: await this.session.exportToHtml(command.path) };
  }

  private async resolveSession(sessionId: string): Promise<SessionInfo> {
    const manager = this.session.sessionManager;
    const sessions = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
    const info = sessions.find((candidate) => candidate.id === sessionId);
    if (!info) {
      throw new HeadlessCommandError({
        code: "invalid_state",
        message: `Persisted Pi session not found: ${sessionId}`,
      });
    }
    return info;
  }

  private async ensureActiveSession(sessionId: string): Promise<void> {
    if (this.session.sessionId === sessionId) return;
    const result = await this.switchSession({ type: "session.switch", sessionId });
    if (isCancelled(result)) {
      throw new HeadlessCommandError({
        code: "cancelled",
        message: `Session switch was cancelled`,
      });
    }
  }

  private async listModels(): Promise<unknown> {
    return this.session.modelRuntime.getAvailableSnapshot().map(modelSummary);
  }

  private async selectModel(command: Command<"model.select">): Promise<unknown> {
    this.requireRootRun(command.runId);
    const selected = findModel(this.session.modelRuntime.getAvailableSnapshot(), command.model);
    if (!selected) {
      throw new HeadlessCommandError({
        code: "invalid_state",
        message: `Model is unavailable: ${command.model.provider}/${command.model.model}`,
      });
    }
    await this.session.setModel(selected);
    return modelSummary(selected);
  }

  private async thinkingLevels(command: Command<"thinking.levels">): Promise<unknown> {
    this.requireRootRun(command.runId);
    return this.session.getAvailableThinkingLevels();
  }

  private async selectThinking(command: Command<"thinking.select">): Promise<unknown> {
    this.requireRootRun(command.runId);
    this.session.setThinkingLevel(piThinkingLevel(command.level));
    return { level: this.session.thinkingLevel };
  }

  private async listCommands(): Promise<unknown> {
    return [
      ...this.session.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        description: command.description,
        source: "extension",
      })),
      ...this.session.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt",
      })),
      ...this.session.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      })),
    ];
  }

  private async invokeCommand(command: Command<"command.invoke">): Promise<unknown> {
    this.requireRootRun(command.runId);
    const text = `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}`;
    return acceptedPrompt(this.session, text, [], undefined);
  }

  private requireRootRun(candidate: string): RunId {
    const binding = this.binding();
    const target = runId(candidate);
    if (target !== binding.rootRunId) {
      throw new HeadlessCommandError({
        code: "unsupported_command",
        message: `Operation is currently supported only by the root Pi session`,
      });
    }
    return target;
  }

  private async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeWorkspace();
    this.#auth.dispose();
    this.#extensionUi.dispose();
    await this.#runtimeHost.dispose();
  }
}

export const PI_HEADLESS_CAPABILITIES = {
  prompting: {
    steering: true,
    followUps: true,
    images: true,
    compaction: true,
    retryControl: true,
  },
  sessions: {
    persistence: true,
    switching: true,
    branching: true,
    import: false,
    export: true,
    tree: true,
  },
  authentication: {
    providerListing: true,
    oauth: true,
    apiKeys: true,
    deviceCode: true,
    browserCallback: true,
    logout: true,
  },
  models: {
    listing: true,
    selection: true,
    thinkingLevels: true,
    virtualModels: true,
  },
  resources: {
    commands: true,
    extensions: true,
    skills: true,
    promptTemplates: true,
    reload: true,
  },
  extensionUi: {
    selection: true,
    confirmation: true,
    textInput: true,
    secretInput: true,
    editor: true,
    notifications: true,
    status: true,
    arbitraryComponents: false,
  },
} as const;

async function acceptedPrompt(
  session: AgentSession,
  text: string,
  images: readonly HeadlessImage[],
  streamingBehavior: "steer" | "follow_up" | undefined,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let accepted = false;
    void session
      .prompt(text, {
        images: piImages(images),
        ...(streamingBehavior
          ? { streamingBehavior: streamingBehavior === "steer" ? "steer" : "followUp" }
          : {}),
        source: "rpc",
        preflightResult: (success) => {
          if (success) {
            accepted = true;
            resolve({ accepted: true });
          } else {
            reject(
              new HeadlessCommandError({
                code: "invalid_state",
                message: "Pi rejected the prompt before execution",
                retryable: true,
              }),
            );
          }
        },
      })
      .catch((error: unknown) => {
        if (!accepted) reject(error);
      });
  });
}

function piImages(images: readonly HeadlessImage[]): ImageContent[] {
  return images.map((image) => ({
    type: "image",
    data: image.data,
    mimeType: image.mediaType,
  }));
}

function piThinkingLevel(level: HeadlessThinkingLevel): ThinkingLevel {
  return level === "off" ? "minimal" : level;
}

type AvailableModel = ReturnType<AgentSession["modelRuntime"]["getAvailableSnapshot"]>[number];

function findModel(
  models: readonly AvailableModel[],
  ref: HeadlessModelRef,
): AvailableModel | undefined {
  return models.find((model) => model.provider === ref.provider && model.id === ref.model);
}

function modelSummary(model: AvailableModel): unknown {
  return {
    provider: model.provider,
    model: model.id,
    displayName: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function sessionSummary(session: AgentSession): unknown {
  return {
    id: session.sessionId,
    name: session.sessionName,
    file: session.sessionFile,
    cwd: session.sessionManager.getCwd(),
    model: session.model ? modelSummary(session.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    pendingMessages: session.pendingMessageCount,
  };
}

function persistedSessionSummary(session: SessionInfo): unknown {
  return {
    id: session.id,
    name: session.name,
    path: session.path,
    cwd: session.cwd,
    parentSessionPath: session.parentSessionPath,
    createdAt: session.created.toISOString(),
    updatedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  };
}

function isCancelled(value: unknown): value is { readonly cancelled: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "cancelled" in value &&
    (value as { readonly cancelled?: unknown }).cancelled === true
  );
}
