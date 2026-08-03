import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { MemoryService } from "../../application/memory-service.ts";
import {
  evidenceId,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryReliability,
  type MemoryRetention,
  type MemoryStatus,
  memoryNoteId,
  type WorkingMemoryProjection,
} from "../../domain/memory/model.ts";
import type { RunId } from "../../domain/shared.ts";

const MEMORY_CONTEXT_TYPE = "phenix:memory-context";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const FOLD_RATIO = 0.5;
const AGGRESSIVE_RATIO = 0.85;
const RECENT_MESSAGE_TAIL = 10;

export const MEMORY_MODEL_INSTRUCTIONS = [
  "Phenix memory interface:",
  "- `phenix_memory` is the model-facing interface to the current run's reversible memory projection.",
  "- Use `action=search` before repeating prior investigation or when earlier requirements, decisions, findings, errors, tests, changes, preferences, procedures, project facts, or outcomes may matter.",
  "- Search results and injected memory are compact indexes, not authoritative detail. Use `action=read` with an evidence ID before relying on omitted specifics or quoting exact output.",
  "- Tool results and run outcomes are captured automatically. Do not create duplicate notes for routine execution output.",
  "- Use `action=note` for durable knowledge that automatic capture cannot infer safely, and attach evidence IDs whenever available.",
  "- Use `action=set_status` when a note becomes uncertain, superseded, invalidated, or active again; never silently preserve contradictory memory as current truth.",
  "- Current user instructions and current repository state outrank recalled notes. Resolve conflicts explicitly and update memory validity when appropriate.",
  "- Objective scope improves retrieval relevance but does not make objectives the canonical memory representation.",
].join("\n");

export function appendMemoryModelInstructions(systemPrompt: string): string {
  if (systemPrompt.includes(MEMORY_MODEL_INSTRUCTIONS)) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${MEMORY_MODEL_INSTRUCTIONS}`;
}

export interface MemorySessionBinding {
  readonly memory: MemoryService;
  readonly runId: RunId;
}

export function createMemorySessionExtension(
  memory: MemoryService,
  runId: RunId,
): ExtensionFactory {
  return (pi) => registerMemoryHooks(pi, () => ({ memory, runId }));
}

export function registerMemoryHooks(
  pi: ExtensionAPI,
  resolve: () => MemorySessionBinding | undefined,
): void {
  registerMemoryTool(pi, resolve);

  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendMemoryModelInstructions(event.systemPrompt),
  }));

  pi.on("tool_result", async (event) => {
    const binding = resolve();
    if (!binding || event.toolName === "phenix_memory") return;
    await binding.memory.captureToolResult({
      runId: binding.runId,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
      content: event.content,
      details: event.details,
      isError: event.isError,
    });
  });

  pi.on("context", async (event, ctx) => {
    const binding = resolve();
    if (!binding) return;
    const contextWindow = modelContextWindow(ctx.model) ?? DEFAULT_CONTEXT_WINDOW;
    return {
      messages: await assembleMemoryContext(
        binding.memory,
        binding.runId,
        event.messages,
        contextWindow,
      ),
    };
  });
}

function registerMemoryTool(
  pi: ExtensionAPI,
  resolve: () => MemorySessionBinding | undefined,
): void {
  pi.registerTool({
    name: "phenix_memory",
    label: "Phenix Memory",
    description:
      "Search compact typed memory, reopen exact immutable evidence, or record durable requirements, constraints, decisions, findings, preferences, procedures, and project facts. Tool results and execution outcomes are captured automatically. Use read when a compact note is insufficient; use set_status when knowledge is superseded, invalidated, uncertain, or active again.",
    promptSnippet: MEMORY_MODEL_INSTRUCTIONS,
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("snapshot"),
          Type.Literal("search"),
          Type.Literal("read"),
          Type.Literal("note"),
          Type.Literal("set_status"),
        ]),
        evidenceId: Type.Optional(Type.String()),
        noteId: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        kind: Type.Optional(Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)))),
        status: Type.Optional(
          Type.Union([
            Type.Literal("active"),
            Type.Literal("superseded"),
            Type.Literal("invalidated"),
            Type.Literal("uncertain"),
          ]),
        ),
        summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
        subject: Type.Optional(Type.String({ maxLength: 500 })),
        evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        retention: Type.Optional(
          Type.Union([
            Type.Literal("must-retain"),
            Type.Literal("structured-lossless"),
            Type.Literal("summary-sufficient"),
            Type.Literal("ephemeral"),
          ]),
        ),
        reliability: Type.Optional(
          Type.Union([Type.Literal("observed"), Type.Literal("derived"), Type.Literal("reported")]),
        ),
        supersedes: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId: string, raw: unknown) {
      const binding = resolve();
      if (!binding) throw new Error("Phenix memory is not bound to this session");
      const params = raw as {
        readonly action: "snapshot" | "search" | "read" | "note" | "set_status";
        readonly evidenceId?: string;
        readonly noteId?: string;
        readonly query?: string;
        readonly kind?: MemoryKind;
        readonly status?: MemoryStatus;
        readonly summary?: string;
        readonly subject?: string;
        readonly evidenceIds?: string[];
        readonly retention?: MemoryRetention;
        readonly reliability?: MemoryReliability;
        readonly supersedes?: string[];
        readonly offset?: number;
        readonly limit?: number;
      };
      const value = await executeMemoryAction(binding, params);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        details: value,
      };
    },
  } as unknown as ToolDefinition);
}

async function executeMemoryAction(
  binding: MemorySessionBinding,
  params: {
    readonly action: "snapshot" | "search" | "read" | "note" | "set_status";
    readonly evidenceId?: string;
    readonly noteId?: string;
    readonly query?: string;
    readonly kind?: MemoryKind;
    readonly status?: MemoryStatus;
    readonly summary?: string;
    readonly subject?: string;
    readonly evidenceIds?: string[];
    readonly retention?: MemoryRetention;
    readonly reliability?: MemoryReliability;
    readonly supersedes?: string[];
    readonly offset?: number;
    readonly limit?: number;
  },
): Promise<unknown> {
  const { memory, runId } = binding;
  switch (params.action) {
    case "snapshot":
      return memory.snapshot((await memory.workingSet(runId, 1)).rootRunId);
    case "search":
      return memory.search({
        runId,
        ...(params.query ? { query: params.query } : {}),
        ...(params.kind ? { kind: params.kind } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.limit ? { limit: Math.min(100, params.limit) } : {}),
      });
    case "read": {
      if (!params.evidenceId) throw new Error("read requires evidenceId");
      const value = await memory.read(runId, evidenceId(params.evidenceId));
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20_000;
      const content = value.content.slice(offset, offset + limit);
      return {
        evidence: value.evidence,
        content,
        offset,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        totalBytes: Buffer.byteLength(value.content, "utf8"),
        truncated: offset + content.length < value.content.length,
      };
    }
    case "note":
      if (!params.kind) throw new Error("note requires kind");
      if (!params.summary?.trim()) throw new Error("note requires summary");
      return memory.recordNote({
        runId,
        kind: params.kind,
        summary: params.summary,
        ...(params.subject ? { subject: params.subject } : {}),
        ...(params.evidenceIds
          ? { evidenceIds: params.evidenceIds.map((id) => evidenceId(id)) }
          : {}),
        ...(params.retention ? { retention: params.retention } : {}),
        ...(params.reliability ? { reliability: params.reliability } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.supersedes
          ? { supersedes: params.supersedes.map((id) => memoryNoteId(id)) }
          : {}),
      });
    case "set_status":
      if (!params.noteId) throw new Error("set_status requires noteId");
      if (!params.status) throw new Error("set_status requires status");
      return memory.setStatus(runId, memoryNoteId(params.noteId), params.status);
  }
}

export async function assembleMemoryContext(
  memory: MemoryService,
  runId: RunId,
  inputMessages: readonly AgentMessage[],
  contextWindow: number,
): Promise<AgentMessage[]> {
  const messages = inputMessages.filter((message) => !isMemoryContextMessage(message));
  const initialTokens = estimateMessages(messages);
  const ratio = initialTokens / Math.max(1, contextWindow);
  const workingSet = await memory.workingSet(runId, ratio >= FOLD_RATIO ? 24 : 10);
  const canvas = renderWorkingMemory(workingSet);
  const transformed =
    ratio >= FOLD_RATIO
      ? await foldToolResults(memory, runId, messages, ratio >= AGGRESSIVE_RATIO)
      : [...messages];

  if (!canvas) return transformed;
  const injection = {
    role: "custom",
    customType: MEMORY_CONTEXT_TYPE,
    content: canvas,
    display: false,
    details: {
      rootRunId: workingSet.rootRunId,
      runId,
      notes: workingSet.notes.map((note) => note.id),
      evidence: workingSet.recentEvidence.map((item) => item.id),
      originalEstimatedTokens: initialTokens,
      folded: ratio >= FOLD_RATIO,
    },
    timestamp: Date.now(),
  } as AgentMessage;
  const insertion = latestUserMessageIndex(transformed);
  if (insertion < 0) return [...transformed, injection];
  return [...transformed.slice(0, insertion), injection, ...transformed.slice(insertion)];
}

async function foldToolResults(
  memory: MemoryService,
  runId: RunId,
  messages: readonly AgentMessage[],
  aggressive: boolean,
): Promise<AgentMessage[]> {
  const tailStart = Math.max(0, messages.length - (aggressive ? 4 : RECENT_MESSAGE_TAIL));
  return Promise.all(
    messages.map(async (message, index) => {
      if (index >= tailStart || !isToolResultMessage(message)) return message;
      const evidence = await memory.evidenceForToolCall(runId, message.toolCallId);
      if (!evidence) return message;
      return {
        ...message,
        content: [
          {
            type: "text" as const,
            text:
              `[Folded tool result]\n${evidence.preview}\n` +
              `Exact evidence: ${evidence.id}. Use phenix_memory action=read evidenceId=${evidence.id}.`,
          },
        ],
      } as AgentMessage;
    }),
  );
}

function renderWorkingMemory(workingSet: WorkingMemoryProjection): string | undefined {
  if (workingSet.objectivePath.length === 0 && workingSet.notes.length === 0) return undefined;
  const lines = [
    "<phenix-memory>",
    "This is a reversible working-memory projection. Compact notes are not source evidence.",
  ];
  if (workingSet.objectivePath.length > 0) {
    lines.push(
      `Objective path: ${workingSet.objectivePath
        .map((objective) => `[${objective.state}] ${objective.title} (${objective.id})`)
        .join(" -> ")}`,
    );
  }
  if (workingSet.notes.length > 0) {
    lines.push("Active memory:");
    for (const note of workingSet.notes) {
      const references =
        note.evidenceIds.length > 0 ? ` evidence=${note.evidenceIds.join(",")}` : "";
      lines.push(
        `- ${note.id} [${note.kind}/${note.status}/${note.reliability}] ${note.summary}${references}`,
      );
    }
  }
  lines.push(
    "Use phenix_memory action=search for other notes and action=read with an evidenceId for exact payloads.",
    "</phenix-memory>",
  );
  const rendered = lines.join("\n");
  return rendered.length <= 8_000 ? rendered : `${rendered.slice(0, 7_999)}…`;
}

function estimateMessages(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += safeStringify(message).length + 24;
  return Math.ceil(chars / 4);
}

function latestUserMessageIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function isToolResultMessage(
  message: AgentMessage,
): message is AgentMessage & { readonly role: "toolResult"; readonly toolCallId: string } {
  return (
    message.role === "toolResult" &&
    typeof (message as { toolCallId?: unknown }).toolCallId === "string"
  );
}

function isMemoryContextMessage(message: AgentMessage): boolean {
  return (
    message.role === "custom" &&
    (message as { customType?: unknown }).customType === MEMORY_CONTEXT_TYPE
  );
}

function modelContextWindow(model: unknown): number | undefined {
  if (!isRecord(model)) return undefined;
  const value = model.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
