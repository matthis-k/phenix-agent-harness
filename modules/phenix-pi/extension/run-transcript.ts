import { open } from "node:fs/promises";

import type { RunTreeNode } from "../application/interfaces.ts";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_BLOCK_TEXT = 12_000;

export type TranscriptRole = "user" | "assistant" | "tool" | "system";

export interface TranscriptEntry {
  readonly role: TranscriptRole;
  readonly text: string;
  readonly timestamp?: string;
  readonly error?: boolean;
}

export interface RunTranscript {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly entries: readonly TranscriptEntry[];
  readonly truncated: boolean;
  readonly unavailable?: string;
}

export async function loadRunTranscript(node: RunTreeNode): Promise<RunTranscript> {
  const sessionId = node.run.pi?.sessionId;
  const sessionFile = node.run.pi?.sessionFile;
  if (!sessionFile) {
    return {
      sessionId,
      entries: [],
      truncated: false,
      unavailable:
        node.run.kind === "agent"
          ? "This agent session has no persisted Pi transcript."
          : "Workflow and local runs do not own a Pi transcript. Select an agent session.",
    };
  }

  try {
    const handle = await open(sessionFile, "r");
    try {
      const stat = await handle.stat();
      const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
      const size = stat.size - start;
      const buffer = Buffer.alloc(size);
      if (size > 0) await handle.read(buffer, 0, size, start);
      const rawLines = buffer.toString("utf8").split("\n");
      if (start > 0) rawLines.shift();
      const entries = rawLines.flatMap(parseSessionLine);
      return {
        sessionId,
        sessionFile,
        entries,
        truncated: start > 0,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      sessionId,
      sessionFile,
      entries: [],
      truncated: false,
      unavailable: `Unable to read transcript: ${errorMessage(error)}`,
    };
  }
}

function parseSessionLine(line: string): readonly TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) return [];
  const message = value.message;
  const timestamp =
    typeof value.timestamp === "string"
      ? value.timestamp
      : typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : undefined;
  const role = message.role;
  if (role === "user") {
    return entry("user", contentText(message.content), timestamp);
  }
  if (role === "assistant") {
    const entries: TranscriptEntry[] = [];
    const text = contentText(message.content, false);
    if (text) entries.push({ role: "assistant", text, timestamp });
    for (const block of contentBlocks(message.content)) {
      if (block.type !== "toolCall" || typeof block.name !== "string") continue;
      const args = "arguments" in block ? compactJson(block.arguments) : "";
      entries.push({
        role: "tool",
        text: args ? `${block.name} ${args}` : block.name,
        timestamp,
      });
    }
    if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
      entries.push({ role: "system", text: message.errorMessage.trim(), timestamp, error: true });
    }
    return entries;
  }
  if (role === "toolResult") {
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = contentText(message.content);
    return [
      {
        role: "tool",
        text: text ? `${name}: ${text}` : name,
        timestamp,
        error: message.isError === true,
      },
    ];
  }
  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "bash";
    const output = typeof message.output === "string" ? normalize(message.output) : "";
    return [
      {
        role: "tool",
        text: output ? `$ ${command}\n${output}` : `$ ${command}`,
        timestamp,
        error: typeof message.exitCode === "number" && message.exitCode !== 0,
      },
    ];
  }
  if (role === "custom" && message.display !== false) {
    return entry("system", contentText(message.content), timestamp);
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    return entry("system", typeof message.summary === "string" ? message.summary : "", timestamp);
  }
  return [];
}

function entry(
  role: TranscriptRole,
  text: string,
  timestamp: string | undefined,
): readonly TranscriptEntry[] {
  return text ? [{ role, text, timestamp }] : [];
}

function contentText(content: unknown, includeToolCalls = true): string {
  if (typeof content === "string") return trimBlock(content);
  const parts: string[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (includeToolCalls && block.type === "toolCall" && typeof block.name === "string") {
      const args = "arguments" in block ? compactJson(block.arguments) : "";
      parts.push(args ? `${block.name} ${args}` : block.name);
    }
  }
  return trimBlock(parts.join("\n"));
}

function contentBlocks(content: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function compactJson(value: unknown): string {
  try {
    return truncate(normalize(JSON.stringify(value)), 240);
  } catch {
    return "";
  }
}

function trimBlock(value: string): string {
  return truncate(
    value
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim(),
    MAX_BLOCK_TEXT,
  );
}

function normalize(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
