import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { RunId } from "../../domain/shared.ts";
import type { MemoryService } from "../../application/memory-service.ts";

const MEMORY_CONTEXT_TYPE = "phenix:memory-context";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const FOLD_RATIO = 0.5;
const AGGRESSIVE_RATIO = 0.85;
const AGGRESSIVE_TARGET_RATIO = 0.65;
const RECENT_MESSAGE_TAIL = 10;

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
  pi.on("tool_result", async (event) => {
    const binding = resolve();
    if (!binding) return;
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

  let transformed = [...messages];
  if (ratio >= FOLD_RATIO) {
    transformed = await foldToolResults(memory, runId, transformed, ratio >= AGGRESSIVE_RATIO);
  }

  if (ratio >= AGGRESSIVE_RATIO && estimateMessages(transformed) > contextWindow * AGGRESSIVE_RATIO) {
    transformed = pruneOldTurns(transformed, Math.floor(contextWindow * AGGRESSIVE_TARGET_RATIO));
  }

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

function pruneOldTurns(messages: readonly AgentMessage[], targetTokens: number): AgentMessage[] {
  if (estimateMessages(messages) <= targetTokens) return [...messages];
  const firstUser = messages.find((message) => message.role === "user");
  const userBoundaries = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index > 0);
  for (const boundary of userBoundaries) {
    const tail = messages.slice(boundary);
    const candidate = firstUser ? [firstUser, ...tail] : tail;
    if (estimateMessages(candidate) <= targetTokens) return dedupeMessageIdentity(candidate);
  }
  const tail = messages.slice(-RECENT_MESSAGE_TAIL);
  return dedupeMessageIdentity(firstUser ? [firstUser, ...tail] : tail);
}

function renderWorkingMemory(
  workingSet: Awaited<ReturnType<MemoryService["workingSet"]>>,
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
      const references = note.evidenceIds.length > 0 ? ` evidence=${note.evidenceIds.join(",")}` : "";
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
  return message.role === "toolResult" && typeof (message as { toolCallId?: unknown }).toolCallId === "string";
}

function isMemoryContextMessage(message: AgentMessage): boolean {
  return (
    message.role === "custom" &&
    (message as { customType?: unknown }).customType === MEMORY_CONTEXT_TYPE
  );
}

function dedupeMessageIdentity(messages: readonly AgentMessage[]): AgentMessage[] {
  const seen = new Set<AgentMessage>();
  return messages.filter((message) => {
    if (seen.has(message)) return false;
    seen.add(message);
    return true;
  });
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
