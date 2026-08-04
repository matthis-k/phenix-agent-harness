import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { MemoryService, MemoryOperation } from "../../application/memory-service.ts";
import {
  evidenceId,
  memoryNoteId,
  type WorkingMemoryProjection,
} from "../../domain/memory/model.ts";
import {
  MEMORY_TOOL_PARAMETERS,
  type MemoryToolRequest,
  parseMemoryToolRequest,
} from "../../domain/memory/tool-protocol.ts";
import type { RunId } from "../../domain/shared.ts";

const MEMORY_CONTEXT_TYPE = "phenix:memory-context";

export const MEMORY_MODEL_INSTRUCTIONS = [
  "Phenix memory interface:",
  "- `phenix_memory` is the closed model-facing interface to the current run's reversible memory projection.",
  "- Valid actions are snapshot, health, search, read, note, and set_status. Each action accepts only its declared fields.",
  "- Use `action=search` before repeating prior investigation or when earlier requirements, decisions, findings, errors, tests, changes, preferences, procedures, project facts, or outcomes may matter.",
  "- Search results and injected memory are compact indexes, not authoritative detail. Use `action=read` with an evidence ID before relying on omitted specifics or quoting exact output.",
  "- Read paging uses UTF-8 byte offsets and returns the next exact byte offset.",
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
    try {
      await binding.memory.captureToolResult({
        runId: binding.runId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input,
        content: event.content,
        details: event.details,
        isError: event.isError,
      });
    } catch (error) {
      await handleMemoryHookFailure(binding, "capture-tool-result", error);
    }
  });

  pi.on("context", async (event, ctx) => {
    const binding = resolve();
    if (!binding) return;
    try {
      const contextWindow =
        modelContextWindow(ctx.model) ?? binding.memory.policy.context.defaultContextWindowTokens;
      return {
        messages: await assembleMemoryContext(
          binding.memory,
          binding.runId,
          event.messages,
          contextWindow,
        ),
      };
    } catch (error) {
      await handleMemoryHookFailure(binding, "assemble-context", error);
      return undefined;
    }
  });
}

function registerMemoryTool(
  pi: ExtensionAPI,
  resolve: () => MemorySessionBinding | undefined,
): void {
  const tool = {
    name: "phenix_memory",
    label: "Phenix Memory",
    description:
      "Inspect health, search compact typed memory, reopen exact immutable evidence, or record and update durable knowledge. The action schema is a closed discriminated union; unrelated or missing fields are rejected before execution.",
    promptSnippet: MEMORY_MODEL_INSTRUCTIONS,
    parameters: MEMORY_TOOL_PARAMETERS,
    async execute(_toolCallId: string, raw: unknown) {
      const binding = resolve();
      if (!binding) throw new Error("Phenix memory is not bound to this session");
      const request = parseMemoryToolRequest(raw);
      const value = await executeMemoryAction(binding, request);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        details: value,
      };
    },
  } as unknown as ToolDefinition;
  pi.registerTool(tool);
}

async function executeMemoryAction(
  binding: MemorySessionBinding,
  request: MemoryToolRequest,
): Promise<unknown> {
  const { memory, runId } = binding;
  switch (request.action) {
    case "snapshot": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.snapshot(workingSet.rootRunId);
    }
    case "health": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.health(workingSet.rootRunId, request.verifyEvidence ?? false);
    }
    case "search":
      return memory.search({
        runId,
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
    case "read": {
      const value = await memory.read(runId, evidenceId(request.evidenceId));
      const requestedLimit = request.limit ?? 20_000;
      const page = utf8Page(
        value.content,
        request.offset ?? 0,
        Math.min(requestedLimit, memory.policy.storage.maximumReadBytes),
      );
      return {
        evidence: value.evidence,
        content: page.content,
        offset: page.offset,
        nextOffset: page.nextOffset,
        returnedBytes: page.returnedBytes,
        totalBytes: page.totalBytes,
        truncated: page.nextOffset < page.totalBytes,
      };
    }
    case "note":
      return memory.recordNote({
        runId,
        kind: request.kind,
        summary: request.summary,
        ...(request.subject === undefined ? {} : { subject: request.subject }),
        ...(request.evidenceIds === undefined
          ? {}
          : { evidenceIds: request.evidenceIds.map((id) => evidenceId(id)) }),
        ...(request.retention === undefined ? {} : { retention: request.retention }),
        ...(request.reliability === undefined ? {} : { reliability: request.reliability }),
        ...(request.status === undefined ? {} : { status: request.status }),
        ...(request.supersedes === undefined
          ? {}
          : { supersedes: request.supersedes.map((id) => memoryNoteId(id)) }),
      });
    case "set_status":
      return memory.setStatus(
        runId,
        memoryNoteId(request.noteId),
        request.status,
        request.status === "invalidated" && request.invalidatedBy !== undefined
          ? memoryNoteId(request.invalidatedBy)
          : undefined,
      );
  }
}

export async function assembleMemoryContext(
  memory: MemoryService,
  runId: RunId,
  inputMessages: readonly AgentMessage[],
  contextWindow: number,
): Promise<AgentMessage[]> {
  const policy = memory.policy.context;
  const messages = inputMessages.filter((message) => !isMemoryContextMessage(message));
  const initialTokens = estimateMessages(messages);
  const ratio = initialTokens / Math.max(1, contextWindow);
  const folded = ratio >= policy.foldAtRatio;
  const aggressive = ratio >= policy.aggressiveFoldAtRatio;
  const workingSet = await memory.workingSet(
    runId,
    folded ? policy.foldedWorkingSetNotes : policy.normalWorkingSetNotes,
  );
  const canvas = renderWorkingMemory(workingSet, policy.maxCanvasCharacters);
  const transformed = folded
    ? await foldToolResults(
        memory,
        runId,
        messages,
        aggressive ? policy.aggressiveMessageTail : policy.recentMessageTail,
      )
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
      contextWindow,
      contextRatio: ratio,
      folded,
      aggressive,
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
  protectedTail: number,
): Promise<AgentMessage[]> {
  const tailStart = Math.max(0, messages.length - protectedTail);
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

function renderWorkingMemory(
  workingSet: WorkingMemoryProjection,
  maximumCharacters: number,
): string | undefined {
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
  return rendered.length <= maximumCharacters
    ? rendered
    : `${rendered.slice(0, Math.max(0, maximumCharacters - 1))}…`;
}

async function handleMemoryHookFailure(
  binding: MemorySessionBinding,
  operation: MemoryOperation,
  error: unknown,
): Promise<void> {
  await binding.memory.reportFailure(binding.runId, operation, error);
  if (binding.memory.policy.captureFailureMode === "strict") throw error;
}

interface Utf8Page {
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly returnedBytes: number;
  readonly totalBytes: number;
}

function utf8Page(content: string, requestedOffset: number, requestedLimit: number): Utf8Page {
  const bytes = Buffer.from(content, "utf8");
  let offset = Math.min(requestedOffset, bytes.length);
  while (offset < bytes.length && isUtf8Continuation(bytes[offset] ?? 0)) offset += 1;

  let end = Math.min(bytes.length, offset + requestedLimit);
  while (end > offset && end < bytes.length && isUtf8Continuation(bytes[end] ?? 0)) end -= 1;
  if (end === offset && offset < bytes.length) {
    end = Math.min(bytes.length, offset + 1);
    while (end < bytes.length && isUtf8Continuation(bytes[end] ?? 0)) end += 1;
  }

  const page = bytes.subarray(offset, end);
  return {
    content: page.toString("utf8"),
    offset,
    nextOffset: end,
    returnedBytes: page.length,
    totalBytes: bytes.length,
  };
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
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
