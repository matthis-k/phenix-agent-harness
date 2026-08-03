import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionEvent,
  EventBus,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { MemoryService } from "../../application/memory-service.ts";
import { STOCK_SESSION_PROMPT_SENTINEL } from "../../definitions/stock-session.ts";
import type { AgentPromptMode } from "../../domain/definition/definition.ts";
import type { ConcreteModelRef } from "../../domain/definition/model.ts";
import type { RunId } from "../../domain/shared.ts";
import type {
  AgentSessionBackend,
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
  AgentTool,
  CreateAgentSessionSpec,
} from "../../ports/agent-session-backend.ts";
import type { LiveAgentTranscriptWriter } from "../../ports/live-agent-transcripts.ts";
import { BoundedAgentSessionPort } from "./bounded-agent-session-port.ts";
import { freeModelSessionExtensions } from "./free-model-guard.ts";
import { createMemorySessionExtension } from "./memory-session-extension.ts";
import { createNixShellTool } from "./nix-shell-tool.ts";
import { composeManagedPrompt } from "./prompt-composition.ts";

export function createObservableChildSessionManager(
  cwd: string,
  sessionDir: string,
): SessionManager {
  return SessionManager.create(cwd, sessionDir);
}

export class PiSdkAgentSessionBackend implements AgentSessionBackend {
  private readonly modelRegistry: ModelRegistry;
  private readonly agentDir: string;
  private readonly eventBus?: EventBus;
  private readonly promptModeForRun: (runId: RunId) => AgentPromptMode | undefined;
  private readonly transcripts: LiveAgentTranscriptWriter;
  private readonly memory: MemoryService;

  constructor(input: {
    readonly modelRegistry: ModelRegistry;
    readonly agentDir: string;
    readonly transcripts: LiveAgentTranscriptWriter;
    readonly memory: MemoryService;
    readonly eventBus?: EventBus;
    readonly promptModeForRun?: (runId: RunId) => AgentPromptMode | undefined;
  }) {
    this.modelRegistry = input.modelRegistry;
    this.agentDir = input.agentDir;
    this.transcripts = input.transcripts;
    this.memory = input.memory;
    this.eventBus = input.eventBus;
    this.promptModeForRun = input.promptModeForRun ?? (() => undefined);
  }

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    // Every child gets a native Pi JSONL transcript for recovery plus a
    // process-local projection that can be inspected before the first flush.
    return this.createWithManager(
      spec,
      createObservableChildSessionManager(
        spec.cwd,
        path.join(this.agentDir, "sessions", "phenix-children"),
      ),
      true,
    );
  }

  async recover(
    spec: CreateAgentSessionSpec,
    reference: AgentSessionReference,
  ): Promise<AgentSessionPort | undefined> {
    if (spec.persistence !== "file" || !reference.sessionFile) return undefined;
    try {
      return await this.createWithManager(spec, SessionManager.open(reference.sessionFile), false);
    } catch {
      return undefined;
    }
  }

  private async createWithManager(
    spec: CreateAgentSessionSpec,
    sessionManager: SessionManager,
    completeHistory: boolean,
  ): Promise<AgentSessionPort> {
    const model = this.modelRegistry.find(spec.model.provider, spec.model.model);
    if (!model)
      throw new Error(`Pi model ${spec.model.provider}/${spec.model.model} is unavailable`);
    const stock = spec.systemPrompt.trimStart().startsWith(STOCK_SESSION_PROMPT_SENTINEL);
    const settingsManager = SettingsManager.create(spec.cwd, this.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      settingsManager,
      ...(this.eventBus ? { eventBus: this.eventBus } : {}),
      noExtensions: true,
      extensionFactories: [
        createMemorySessionExtension(this.memory, spec.runId),
        ...freeModelSessionExtensions(isFreeTierModel(spec.model)),
      ],
      ...(stock
        ? {}
        : {
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: spec.context.projectFiles === "none",
            ...(spec.context.projectFiles === "none"
              ? {}
              : {
                  agentsFilesOverride: (current: {
                    agentsFiles: Array<{ path: string; content: string }>;
                  }) => ({
                    agentsFiles: limitContextFiles(
                      current.agentsFiles,
                      spec.context.projectFiles === "inherit" ? "inherit" : "selected",
                      spec.context.artifacts,
                      spec.context.maxBytes,
                    ),
                  }),
                }),
            ...composeManagedPrompt(this.promptModeForRun(spec.runId), spec.systemPrompt),
          }),
    });
    await resourceLoader.reload();
    const modelRuntime = await this.createModelRuntime();
    const customTools = [
      ...spec.customTools.filter((tool) => !stock || tool.name !== "phenix_progress").map(toPiTool),
      ...(!stock && spec.tools.includes("nix_shell") ? [createNixShellTool(spec.cwd)] : []),
    ] as ToolDefinition[];
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime,
      thinkingLevel: spec.thinking,
      ...(stock ? {} : { tools: [...new Set([...spec.tools, "phenix_memory"])] }),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return new BoundedAgentSessionPort(
      new PiAgentSessionPort(spec.runId, session, this.transcripts, completeHistory),
    );
  }

  private async createModelRuntime(): Promise<ModelRuntime> {
    const runtime = await ModelRuntime.create({
      authPath: path.join(this.agentDir, "auth.json"),
      modelsPath: path.join(this.agentDir, "models.json"),
    });
    for (const providerId of this.modelRegistry.getRegisteredProviderIds()) {
      const config = this.modelRegistry.getRegisteredProviderConfig(providerId);
      if (config) runtime.registerProvider(providerId, config);
    }
    return runtime;
  }
}

class PiAgentSessionPort implements AgentSessionPort {
  private readonly session: AgentSession;
  private readonly transcripts: LiveAgentTranscriptWriter;
  private readonly runId: RunId;
  private readonly completedMessages: AgentMessage[] = [];
  private streamingMessage: AgentMessage | undefined;
  private readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    runId: RunId,
    session: AgentSession,
    transcripts: LiveAgentTranscriptWriter,
    completeHistory: boolean,
  ) {
    this.runId = runId;
    this.session = session;
    this.transcripts = transcripts;
    this.transcripts.open(runId, this.reference, completeHistory);
    this.unsubscribe = session.subscribe((event) => this.observe(event));
  }

  get reference(): AgentSessionReference {
    return {
      sessionId: this.session.sessionId,
      ...(this.session.sessionFile ? { sessionFile: this.session.sessionFile } : {}),
    };
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  async prompt(message: string): Promise<void> {
    let preflightSeen = false;
    let accept: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const accepted = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });
    const fullRun = this.session.prompt(message, {
      preflightResult: (success) => {
        preflightSeen = true;
        if (success) accept();
        else reject(new Error("Pi rejected the child prompt before execution"));
      },
    });
    void fullRun.then(
      () => {
        if (!preflightSeen) accept();
      },
      (error: unknown) => {
        if (!preflightSeen) reject(error);
        this.emit({
          type: "backend.failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      },
    );
    await accepted;
  }

  async steer(message: string): Promise<void> {
    await this.session.steer(message);
  }

  async followUp(message: string): Promise<void> {
    await this.session.followUp(message);
  }

  async notify(message: string): Promise<void> {
    await this.session.sendCustomMessage(
      {
        customType: "phenix:background-completion",
        content: message,
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.session.dispose();
    this.listeners.clear();
  }

  subscribe(listener: (event: AgentSessionObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private observe(event: AgentSessionEvent): void {
    if (event.type === "message_update" && event.message.role === "assistant") {
      this.streamingMessage = event.message;
      this.publishTranscript();
      return;
    }
    if (event.type === "message_end") {
      this.completedMessages.push(event.message);
      if (event.message.role === "assistant") this.streamingMessage = undefined;
      this.publishTranscript();
      if (
        event.message.role === "assistant" &&
        (event.message.stopReason === "error" || event.message.stopReason === "aborted")
      ) {
        this.emit({
          type: "backend.failed",
          message:
            event.message.errorMessage ??
            (event.message.stopReason === "aborted"
              ? "Pi assistant turn ended with stopReason=aborted"
              : "Pi provider failed"),
          retryable: true,
        });
      }
      return;
    }
    if (event.type === "agent_settled") {
      this.emit({ type: "cycle.settled" });
      return;
    }
    if (event.type === "turn_end") {
      this.emit({ type: "turn.ended" });
      return;
    }
    if (event.type === "tool_execution_start") {
      this.emit({
        type: "tool.started",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.args,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      this.emit({
        type: "tool.finished",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
      });
    }
  }

  private publishTranscript(): void {
    this.transcripts.replace(this.runId, [
      ...this.completedMessages,
      ...(this.streamingMessage ? [this.streamingMessage] : []),
    ]);
  }

  private emit(event: AgentSessionObservation): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toPiTool(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.description,
    parameters: tool.parameters.jsonSchema,
    execute: async (_toolCallId, params, signal) => {
      const result = await tool.execute(params, signal);
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  } as ToolDefinition;
}

function isFreeTierModel(model: ConcreteModelRef): boolean {
  return model.model.includes("free") || model.provider.includes("free");
}

function limitContextFiles(
  files: readonly { path: string; content: string }[],
  mode: "inherit" | "selected",
  selected: readonly string[],
  maxBytes: number,
): Array<{ path: string; content: string }> {
  const allowed =
    mode === "inherit"
      ? files
      : files.filter((file) => selected.some((entry) => file.path.endsWith(entry)));
  const result: Array<{ path: string; content: string }> = [];
  let used = 0;
  for (const file of allowed) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (used + bytes > maxBytes) break;
    result.push({ path: file.path, content: file.content });
    used += bytes;
  }
  return result;
}
