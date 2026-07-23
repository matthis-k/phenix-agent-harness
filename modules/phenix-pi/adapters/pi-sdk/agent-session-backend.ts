import path from "node:path";

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

import type {
  AgentSessionBackend,
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
  AgentTool,
  CreateAgentSessionSpec,
} from "../../ports/agent-session-backend.ts";

export class PiSdkAgentSessionBackend implements AgentSessionBackend {
  private readonly modelRegistry: ModelRegistry;
  private readonly agentDir: string;
  private readonly eventBus?: EventBus;

  constructor(input: {
    readonly modelRegistry: ModelRegistry;
    readonly agentDir: string;
    readonly eventBus?: EventBus;
  }) {
    this.modelRegistry = input.modelRegistry;
    this.agentDir = input.agentDir;
    this.eventBus = input.eventBus;
  }

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    const manager =
      spec.persistence === "memory"
        ? SessionManager.inMemory(spec.cwd)
        : SessionManager.create(spec.cwd);
    return this.createWithManager(spec, manager);
  }

  async recover(
    spec: CreateAgentSessionSpec,
    reference: AgentSessionReference,
  ): Promise<AgentSessionPort | undefined> {
    if (spec.persistence !== "file" || !reference.sessionFile) return undefined;
    try {
      return await this.createWithManager(spec, SessionManager.open(reference.sessionFile));
    } catch {
      return undefined;
    }
  }

  private async createWithManager(
    spec: CreateAgentSessionSpec,
    sessionManager: SessionManager,
  ): Promise<AgentSessionPort> {
    const model = this.modelRegistry.find(spec.model.provider, spec.model.model);
    if (!model)
      throw new Error(`Pi model ${spec.model.provider}/${spec.model.model} is unavailable`);
    const settingsManager = SettingsManager.create(spec.cwd, this.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      settingsManager,
      ...(this.eventBus ? { eventBus: this.eventBus } : {}),
      noExtensions: true,
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
      systemPrompt: spec.systemPrompt,
    });
    await resourceLoader.reload();
    const modelRuntime = await this.createModelRuntime();
    const customTools = spec.customTools.map(toPiTool) as ToolDefinition[];
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      model,
      modelRuntime,
      thinkingLevel: spec.thinking,
      tools: [...spec.tools],
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    return new PiAgentSessionPort(session);
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
  private readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(session: AgentSession) {
    this.session = session;
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
        else reject(new Error(`Pi rejected the child prompt before execution`));
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
      return;
    }
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "error"
    ) {
      this.emit({
        type: "backend.failed",
        message: event.message.errorMessage ?? "Pi provider failed",
        retryable: true,
      });
    }
  }

  private emit(event: AgentSessionObservation): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Observers cannot change Pi transport state.
      }
    }
  }
}

function limitContextFiles(
  files: readonly { readonly path: string; readonly content: string }[],
  policy: "inherit" | "selected",
  selectors: readonly string[],
  maxBytes: number,
): Array<{ path: string; content: string }> {
  const selected =
    policy === "inherit"
      ? files
      : files.filter((file) => selectors.some((selector) => file.path.includes(selector)));
  let remaining = Math.max(0, maxBytes);
  const output: Array<{ path: string; content: string }> = [];
  for (const file of selected) {
    if (remaining === 0) break;
    const encoded = Buffer.from(file.content, "utf8");
    const content =
      encoded.byteLength <= remaining ? file.content : truncateUtf8(encoded, remaining);
    output.push({ path: file.path, content });
    remaining -= Buffer.byteLength(content, "utf8");
  }
  return output;
}

function truncateUtf8(encoded: Buffer, maxBytes: number): string {
  let value = encoded.subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(value, "utf8") > maxBytes) value = value.slice(0, -1);
  return value;
}

function toPiTool(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters.jsonSchema,
    async execute(_toolCallId, input, signal) {
      const result = await tool.execute(input, signal);
      return {
        content: [{ type: "text" as const, text: result.text }],
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  } as ToolDefinition;
}
