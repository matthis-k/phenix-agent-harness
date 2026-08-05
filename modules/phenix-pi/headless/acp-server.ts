import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { HeadlessCommand } from "./protocol.ts";
import {
  arrayValue,
  configValue,
  definitionId,
  extractSelectedBranchTranscript,
  projectSessionTreeSnapshot,
  promptContent,
  record,
  requiredString,
  stringValue,
  thinkingLevel,
  toolKind,
  transcriptBlock,
} from "./acp-codec.ts";

export {
  extractSelectedBranchTranscript,
  projectSessionTreeSnapshot,
  promptContent,
} from "./acp-codec.ts";

const PHENIX_METHODS = {
  sessionTreeCreate: "_phenix/session_tree/create",
  sessionTreeGet: "_phenix/session_tree/get",
  sessionTreeList: "_phenix/session_tree/list",
  workflowStart: "_phenix/workflow/start",
  routingExplain: "_phenix/routing/explain",
} as const;

type PhenixMethod = (typeof PHENIX_METHODS)[keyof typeof PHENIX_METHODS];

export interface HeadlessRuntimeFacade {
  execute(command: HeadlessCommand): Promise<unknown>;
  subscribe(listener: (event: unknown) => void | Promise<void>): () => void;
}

export interface PhenixAcpServer {
  readonly closed: Promise<void>;
  dispose(): void;
}

interface SessionBinding {
  readonly sessionId: string;
  readonly runId: string;
}

interface PromptCompletion {
  readonly cancelled: boolean;
  resolve(reason: acp.StopReason): void;
  reject(error: unknown): void;
}

export function servePhenixAcp(
  runtime: HeadlessRuntimeFacade,
  streams: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
  } = {},
): PhenixAcpServer {
  const input = Readable.toWeb(
    (streams.input ?? process.stdin) as Readable,
  ) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb((streams.output ?? process.stdout) as Writable);
  const stream = acp.ndJsonStream(output, input);
  let agent: PhenixAcpAgent | undefined;
  const connection = new acp.AgentSideConnection((client) => {
    agent = new PhenixAcpAgent(runtime, client);
    return agent;
  }, stream);
  void connection.closed.finally(() => agent?.dispose());
  return {
    closed: connection.closed,
    dispose: () => agent?.dispose(),
  };
}

export class PhenixAcpAgent implements acp.Agent {
  readonly #runtime: HeadlessRuntimeFacade;
  readonly #client: acp.AgentSideConnection;
  readonly #sessions = new Map<string, SessionBinding>();
  readonly #promptCompletions = new Map<string, PromptCompletion>();
  readonly #transcriptText = new Map<string, string>();
  readonly #definitions = new Map<string, unknown>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(runtime: HeadlessRuntimeFacade, client: acp.AgentSideConnection) {
    this.#runtime = runtime;
    this.#client = client;
    this.#unsubscribe = runtime.subscribe((event) => this.#onEvent(event));
  }

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    const client = record(params.clientInfo);
    await this.#runtime.execute({
      type: "initialize",
      client: {
        name: stringValue(client.name) ?? "acp-client",
        build: stringValue(client.version) ?? String(params.protocolVersion),
      },
    });
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          fork: {},
          resume: {},
        },
      },
    } as acp.InitializeResponse;
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    await this.#runtime.execute({ type: "session.create" });
    const binding = await this.#bindActiveSession();
    await this.#publishAvailableCommands(binding);
    return {
      sessionId: binding.sessionId,
    } as acp.NewSessionResponse;
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    await this.#runtime.execute({ type: "session.switch", sessionId: params.sessionId });
    const binding = await this.#bindActiveSession();
    await this.#replaySelectedBranch(binding);
    await this.#publishAvailableCommands(binding);
    return {} as acp.LoadSessionResponse;
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    await this.#runtime.execute({ type: "session.switch", sessionId: params.sessionId });
    await this.#bindActiveSession();
    return {} as acp.ResumeSessionResponse;
  }

  async unstable_forkSession(params: acp.ForkSessionRequest): Promise<acp.ForkSessionResponse> {
    await this.#runtime.execute({ type: "session.clone", sessionId: params.sessionId });
    const binding = await this.#bindActiveSession();
    return { sessionId: binding.sessionId } as acp.ForkSessionResponse;
  }

  async listSessions(_params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const raw = await this.#runtime.execute({ type: "session.list" });
    const sessions = arrayValue(raw).map((value) => {
      const session = record(value);
      return {
        sessionId: requiredString(session.id, "persisted session id"),
        cwd: stringValue(session.cwd) ?? process.cwd(),
        title: stringValue(session.name),
        updatedAt: stringValue(session.updatedAt),
      };
    });
    return { sessions } as acp.ListSessionsResponse;
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const binding = this.#requireSession(params.sessionId);
    await this.#runtime.execute({ type: "execution.abort", runId: binding.runId });
    this.#sessions.delete(params.sessionId);
    return {};
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const binding = this.#requireSession(params.sessionId);
    await this.#runtime.execute({
      type: "command.invoke",
      runId: binding.runId,
      name: "mode",
      arguments: String(params.modeId),
    });
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const binding = this.#requireSession(params.sessionId);
    const optionId = String(params.configId);
    const value = configValue(params.value);
    if (optionId === "model") {
      const [provider, model] = value.split("/", 2);
      if (!provider || !model) throw new Error(`Invalid model reference: ${value}`);
      await this.#runtime.execute({
        type: "model.select",
        runId: binding.runId,
        model: { provider, model },
      });
    } else if (optionId === "thinking") {
      await this.#runtime.execute({
        type: "thinking.select",
        runId: binding.runId,
        level: thinkingLevel(value),
      });
    } else {
      throw new Error(`Unsupported ACP session config option: ${optionId}`);
    }
    return {
      configOptions: await this.#configOptions(binding),
    } as acp.SetSessionConfigOptionResponse;
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const binding = this.#requireSession(params.sessionId);
    if (this.#promptCompletions.has(binding.runId)) {
      throw new Error(`Run ${binding.runId} already has an active prompt`);
    }
    const prompt = promptContent(params.prompt);
    const result = new Promise<acp.StopReason>((resolve, reject) => {
      this.#promptCompletions.set(binding.runId, {
        cancelled: false,
        resolve,
        reject,
      });
    });
    try {
      await this.#runtime.execute({
        type: "prompt.submit",
        runId: binding.runId,
        text: prompt.text,
        images: prompt.images,
      });
      return { stopReason: await result };
    } catch (error) {
      this.#promptCompletions.delete(binding.runId);
      throw error;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const binding = this.#requireSession(params.sessionId);
    const pending = this.#promptCompletions.get(binding.runId);
    if (pending) {
      this.#promptCompletions.set(binding.runId, { ...pending, cancelled: true });
    }
    await this.#runtime.execute({ type: "execution.abort", runId: binding.runId });
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method as PhenixMethod) {
      case PHENIX_METHODS.sessionTreeCreate:
        return this.#createSessionTree(params);
      case PHENIX_METHODS.sessionTreeGet:
        return this.#getSessionTree(params);
      case PHENIX_METHODS.sessionTreeList:
        return this.#listSessionTrees();
      case PHENIX_METHODS.workflowStart:
        return this.#startWorkflow(params);
      case PHENIX_METHODS.routingExplain:
        return this.#explainRouting(params);
      default:
        throw new Error(`Unsupported Phenix ACP extension method: ${method}`);
    }
  }

  async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    for (const completion of this.#promptCompletions.values()) {
      completion.reject(new Error("ACP connection closed"));
    }
    this.#promptCompletions.clear();
  }

  async #bindActiveSession(): Promise<SessionBinding> {
    const snapshot = record(await this.#runtime.execute({ type: "snapshot.request" }));
    const session = record(snapshot.activeSession);
    const sessionId = requiredString(session.id, "active session id");
    const runId = requiredString(snapshot.rootRunId, "root run id");
    const binding = { sessionId, runId };
    this.#sessions.set(sessionId, binding);
    return binding;
  }

  #requireSession(sessionId: string): SessionBinding {
    const binding = this.#sessions.get(sessionId);
    if (!binding) throw new Error(`Unknown ACP session: ${sessionId}`);
    return binding;
  }

  async #onEvent(rawEvent: unknown): Promise<void> {
    const event = record(rawEvent);
    const type = stringValue(event.type);
    const runId = stringValue(event.runId) ?? stringValue(record(event.block).runId);
    const binding = runId ? this.#bindingForRun(runId) : undefined;

    if (binding && (type === "transcript.appended" || type === "transcript.updated")) {
      const block = transcriptBlock(event.block);
      if (block && (block.role === "assistant" || block.role === "thinking")) {
        const previous = this.#transcriptText.get(block.id) ?? "";
        const delta = block.text.startsWith(previous) ? block.text.slice(previous.length) : block.text;
        this.#transcriptText.set(block.id, block.text);
        if (delta.length > 0) {
          await this.#client.sessionUpdate({
            sessionId: binding.sessionId,
            update: {
              sessionUpdate:
                block.role === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
              content: { type: "text", text: delta },
            },
          } as acp.SessionNotification);
        }
      }
    } else if (binding && type === "tool.started") {
      await this.#client.sessionUpdate({
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: requiredString(event.toolCallId, "tool call id"),
          title: stringValue(event.toolName) ?? "Tool call",
          kind: toolKind(stringValue(event.toolName)),
          status: "in_progress",
          rawInput: stringValue(event.inputSummary),
        },
      } as acp.SessionNotification);
    } else if (binding && (type === "tool.updated" || type === "tool.finished")) {
      const failed = type === "tool.finished" && event.outcome === "failed";
      const output = stringValue(event.output) ?? stringValue(event.outputSummary) ?? "";
      await this.#client.sessionUpdate({
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: requiredString(event.toolCallId, "tool call id"),
          status: type === "tool.updated" ? "in_progress" : failed ? "failed" : "completed",
          content: output
            ? [{ type: "content", content: { type: "text", text: output } }]
            : undefined,
          rawOutput: output,
        },
      } as acp.SessionNotification);
    }

    if (runId && type === "agent.settled") {
      const completion = this.#promptCompletions.get(runId);
      if (completion) {
        this.#promptCompletions.delete(runId);
        completion.resolve(completion.cancelled ? "cancelled" : "end_turn");
      }
    }

    if (type === "snapshot.changed") {
      await this.#client.extNotification("_phenix/snapshot", record(event.snapshot));
    }
    await this.#client.extNotification("_phenix/event", event);
  }

  #bindingForRun(runId: string): SessionBinding | undefined {
    return [...this.#sessions.values()].find((binding) => binding.runId === runId);
  }

  async #publishAvailableCommands(binding: SessionBinding): Promise<void> {
    const raw = await this.#runtime.execute({ type: "command.list" });
    const availableCommands = arrayValue(raw).map((value) => {
      const command = record(value);
      return {
        name: requiredString(command.name, "command name"),
        description: stringValue(command.description) ?? "",
        input: { hint: "arguments" },
      };
    });
    if (availableCommands.length === 0) return;
    await this.#client.sessionUpdate({
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands,
      },
    } as acp.SessionNotification);
  }

  async #configOptions(binding: SessionBinding): Promise<acp.SessionConfigOption[]> {
    const [modelsRaw, thinkingRaw, snapshotRaw] = await Promise.all([
      this.#runtime.execute({ type: "model.list" }),
      this.#runtime.execute({ type: "thinking.levels", runId: binding.runId }),
      this.#runtime.execute({ type: "snapshot.request" }),
    ]);
    const activeSession = record(record(snapshotRaw).activeSession);
    const currentModel = record(activeSession.model);
    const modelValue =
      stringValue(currentModel.provider) && stringValue(currentModel.model)
        ? `${String(currentModel.provider)}/${String(currentModel.model)}`
        : undefined;
    const currentThinking = stringValue(activeSession.thinkingLevel);
    const options: acp.SessionConfigOption[] = [];
    const models = arrayValue(modelsRaw).map((value) => {
      const model = record(value);
      return {
        value: `${requiredString(model.provider, "model provider")}/${requiredString(model.model, "model id")}`,
        name: stringValue(model.displayName) ?? requiredString(model.model, "model id"),
      };
    });
    if (models.length > 0) {
      options.push({
        id: "model",
        name: "Model",
        description: "Model used by the active Phenix session",
        category: "model",
        type: "select",
        currentValue: modelValue ?? models[0]?.value ?? "",
        options: models,
      } as acp.SessionConfigOption);
    }
    const thinking = arrayValue(thinkingRaw).map((value) => ({
      value: String(value),
      name: String(value),
    }));
    if (thinking.length > 0) {
      options.push({
        id: "thinking",
        name: "Thinking",
        description: "Reasoning effort for the active Phenix session",
        category: "thought_level",
        type: "select",
        currentValue: currentThinking ?? thinking[0]?.value ?? "off",
        options: thinking,
      } as acp.SessionConfigOption);
    }
    return options;
  }

  async #replaySelectedBranch(binding: SessionBinding): Promise<void> {
    const raw = await this.#runtime.execute({
      type: "session.tree",
      sessionId: binding.sessionId,
    });
    for (const block of extractSelectedBranchTranscript(raw)) {
      const update =
        block.role === "user"
          ? "user_message_chunk"
          : block.role === "thinking"
            ? "agent_thought_chunk"
            : "agent_message_chunk";
      await this.#client.sessionUpdate({
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: update,
          content: { type: "text", text: block.text },
        },
      } as acp.SessionNotification);
    }
  }

  async #createSessionTree(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const definition = params.definition;
    if (!definition) throw new Error("_phenix/session_tree/create requires a definition");
    await this.#runtime.execute({ type: "session.create" });
    const binding = await this.#bindActiveSession();
    const treeId = `tree-${binding.sessionId}`;
    this.#definitions.set(treeId, definition);
    return { tree_id: treeId };
  }

  async #getSessionTree(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const treeId = requiredString(params.tree_id, "tree id");
    const snapshot = record(await this.#runtime.execute({ type: "snapshot.request" }));
    return projectSessionTreeSnapshot(treeId, snapshot, this.#definitions.get(treeId));
  }

  async #listSessionTrees(): Promise<Record<string, unknown>> {
    const raw = await this.#runtime.execute({ type: "session.list" });
    return {
      trees: arrayValue(raw).map((value) => {
        const session = record(value);
        const sessionId = requiredString(session.id, "session id");
        const treeId = `tree-${sessionId}`;
        return {
          tree_id: treeId,
          definition_id: definitionId(this.#definitions.get(treeId)),
          root_session: sessionId,
        };
      }),
    };
  }

  async #startWorkflow(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const treeId = requiredString(params.tree_id, "tree id");
    const workflow = requiredString(params.workflow, "workflow id");
    const objective = requiredString(params.objective, "workflow objective");
    const sessionId = treeId.replace(/^tree-/, "");
    const binding = this.#requireSession(sessionId);
    await this.#runtime.execute({
      type: "command.invoke",
      runId: binding.runId,
      name: workflow,
      arguments: objective,
    });
    return {
      objective_id: `objective-${binding.runId}`,
      root_node_id: binding.runId,
    };
  }

  async #explainRouting(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const snapshot = record(await this.#runtime.execute({ type: "snapshot.request" }));
    const active = record(snapshot.activeSession);
    const model = record(active.model);
    const provider = stringValue(model.provider);
    const modelId = stringValue(model.model);
    return {
      router: "phenix.runtime",
      backend: "pi",
      model: provider && modelId ? { provider, model: modelId } : null,
      explanation: `The immutable session-tree configuration selected the active Pi backend for ${requiredString(params.objective, "objective")}.`,
    };
  }
}
