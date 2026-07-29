import { readFile } from "node:fs/promises";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  buildContextEntries,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  type FileEntry,
  getMarkdownTheme,
  migrateSessionEntries,
  parseSessionEntries,
  parseSkillBlock,
  type SessionEntry,
  SkillInvocationMessageComponent,
  sessionEntryToContextMessages,
  ToolExecutionComponent,
  type TruncationResult,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";
import type {
  LoadedWorkspaceTranscript,
  ReadyWorkspaceTranscript,
} from "../ports/workspace-effects.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";
import {
  nativeResultEntryData,
  renderNativeResultEntry,
  RESULT_ENTRY_TYPE,
} from "./result-display.ts";
import { renderNativeRunTranscriptResult } from "./native-run-transcript-view.ts";

export type NativeTranscriptChunkKind =
  | "user"
  | "assistant"
  | "tool"
  | "bash"
  | "custom-message"
  | "summary"
  | "result";

export interface NativeTranscriptChunk {
  readonly id: string;
  readonly kind: NativeTranscriptChunkKind;
  readonly component: Component;
}

export class NativeTranscriptComponent extends Container {
  private readonly chunkValues: NativeTranscriptChunk[] = [];

  get chunks(): readonly NativeTranscriptChunk[] {
    return this.chunkValues;
  }

  addChunk(chunk: NativeTranscriptChunk, spacer = false): void {
    if (spacer && this.chunkValues.length > 0) this.addChild(new Spacer(1));
    this.chunkValues.push(chunk);
    this.addChild(chunk.component);
  }
}

export interface NativeRunTranscript {
  readonly component: NativeTranscriptComponent;
  readonly sessionId: string;
  readonly sessionFile?: string;
}

export function readyNativeRunTranscript(
  transcript: NativeRunTranscript,
  fallbackKey = "native-transcript",
): ReadyWorkspaceTranscript<NativeRunTranscript> {
  return {
    kind: "ready",
    handle: { key: transcript.sessionFile ?? transcript.sessionId ?? fallbackKey },
    value: transcript,
  };
}

export async function loadNativeRunTranscript(
  node: RunTreeNode,
  tui: TUI,
  theme?: ObservabilityTheme,
): Promise<NativeRunTranscript> {
  return renderNativeRunTranscriptResult(
    await loadNativeRunTranscriptResult(node, tui, theme),
    node,
  );
}

export async function loadNativeRunTranscriptResult(
  node: RunTreeNode,
  tui: TUI,
  theme?: ObservabilityTheme,
): Promise<LoadedWorkspaceTranscript<NativeRunTranscript>> {
  if (node.run.kind === "workflow") {
    return { kind: "not-applicable", reason: "workflow" };
  }

  const sessionFile = node.run.pi?.sessionFile;
  if (!sessionFile) {
    if (node.run.kind === "root") {
      return { kind: "not-applicable", reason: "root-projection" };
    }
    return node.run.pi?.sessionId
      ? { kind: "pending-persistence", runId: node.run.id }
      : { kind: "legacy", runId: node.run.id };
  }

  let source: string;
  try {
    source = await readFile(sessionFile, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return { kind: "pending-persistence", runId: node.run.id };
  }

  let fileEntries: FileEntry[];
  try {
    fileEntries = parseSessionEntries(source);
    migrateSessionEntries(fileEntries);
  } catch (error) {
    return {
      kind: "invalid",
      reason: `The persisted Pi transcript is invalid: ${errorMessage(error)}`,
    };
  }
  const header = fileEntries.find((entry) => entry.type === "session");
  if (header?.type !== "session") {
    return {
      kind: "invalid",
      reason: "The persisted session file is not a valid Pi transcript.",
    };
  }

  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  return readyNativeRunTranscript(
    {
      component: renderNativeTranscript(buildContextEntries(entries), tui, header.cwd, theme),
      sessionId: header.id,
      sessionFile,
    },
    `run:${String(node.run.id)}:transcript`,
  );
}

export function renderNativeTranscript(
  entries: readonly SessionEntry[],
  tui: TUI,
  cwd: string,
  theme?: ObservabilityTheme,
): NativeTranscriptComponent {
  const transcript = new NativeTranscriptComponent();
  const markdownTheme = getMarkdownTheme();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  let chunkSequence = 0;

  const add = (
    kind: NativeTranscriptChunkKind,
    component: Component,
    spacer = false,
    sourceId?: string,
  ): void => {
    transcript.addChunk(
      {
        id: sourceId ?? `chunk-${chunkSequence}`,
        kind,
        component,
      },
      spacer,
    );
    chunkSequence += 1;
  };

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === RESULT_ENTRY_TYPE) {
      const data = nativeResultEntryData(entry.data);
      if (data) add("result", renderNativeResultEntry(data, theme), true, entry.id);
      continue;
    }

    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role === "assistant") {
        add(
          "assistant",
          new AssistantMessageComponent(message, true, markdownTheme, "Thinking...", 1),
          true,
        );
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const tool = new ToolExecutionComponent(
            content.name,
            content.id,
            content.arguments,
            { showImages: true, imageWidthCells: 60 },
            undefined,
            tui,
            cwd,
          );
          tool.setExpanded(false);
          add("tool", tool, false, content.id);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            tool.updateResult({
              content: [
                {
                  type: "text",
                  text:
                    message.stopReason === "aborted"
                      ? "Operation aborted"
                      : message.errorMessage || "Error",
                },
              ],
              isError: true,
            });
          } else {
            pendingTools.set(content.id, tool);
          }
        }
        continue;
      }

      if (message.role === "toolResult") {
        const tool = pendingTools.get(message.toolCallId);
        if (tool) {
          tool.updateResult(message);
          pendingTools.delete(message.toolCallId);
        }
        continue;
      }

      addNativeMessage(message, tui, markdownTheme, add);
    }
  }

  return transcript;
}

function addNativeMessage(
  message: Exclude<AgentMessage, { role: "assistant" | "toolResult" }>,
  tui: TUI,
  markdownTheme: ReturnType<typeof getMarkdownTheme>,
  add: (
    kind: NativeTranscriptChunkKind,
    component: Component,
    spacer?: boolean,
    sourceId?: string,
  ) => void,
): void {
  switch (message.role) {
    case "user": {
      const text = userMessageText(message);
      if (!text) return;
      const skill = parseSkillBlock(text);
      if (skill) {
        const invocation = new SkillInvocationMessageComponent(skill, markdownTheme);
        invocation.setExpanded(false);
        add("user", invocation, true);
        if (skill.userMessage) {
          add("user", new UserMessageComponent(skill.userMessage, markdownTheme, 1), true);
        }
      } else {
        add("user", new UserMessageComponent(text, markdownTheme, 1), true);
      }
      return;
    }
    case "bashExecution": {
      const component = new BashExecutionComponent(
        message.command,
        tui,
        message.excludeFromContext,
      );
      if (message.output) component.appendOutput(message.output);
      component.setComplete(
        message.exitCode,
        message.cancelled,
        message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
        message.fullOutputPath,
      );
      component.setExpanded(false);
      add("bash", component, false);
      return;
    }
    case "custom": {
      if (!message.display) return;
      const component = new CustomMessageComponent(message, undefined, markdownTheme);
      component.setExpanded(false);
      add("custom-message", component, false);
      return;
    }
    case "compactionSummary": {
      const component = new CompactionSummaryMessageComponent(message, markdownTheme);
      component.setExpanded(false);
      add("summary", component, true);
      return;
    }
    case "branchSummary": {
      const component = new BranchSummaryMessageComponent(message, markdownTheme);
      component.setExpanded(false);
      add("summary", component, true);
      return;
    }
  }
}

function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("");
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function transcriptFileEntries(source: string): readonly FileEntry[] {
  const entries = parseSessionEntries(source);
  migrateSessionEntries(entries);
  return entries;
}
