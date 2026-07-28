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
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";

import type { RunTreeNode } from "../application/interfaces.ts";

export interface NativeRunTranscript {
  readonly component?: Container;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly unavailable?: string;
}

export async function loadNativeRunTranscript(
  node: RunTreeNode,
  tui: TUI,
): Promise<NativeRunTranscript> {
  const sessionFile = node.run.pi?.sessionFile;
  if (!sessionFile) {
    return {
      sessionId: node.run.pi?.sessionId,
      unavailable: "This run has no Pi transcript reference; it may predate transcript persistence.",
    };
  }

  let source: string;
  try {
    source = await readFile(sessionFile, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return {
      sessionId: node.run.pi?.sessionId,
      sessionFile,
      unavailable: "Pi has allocated this transcript but has not flushed its first response yet.",
    };
  }
  const fileEntries = parseSessionEntries(source);
  migrateSessionEntries(fileEntries);
  const header = fileEntries.find((entry) => entry.type === "session");
  if (header?.type !== "session") {
    return {
      sessionId: node.run.pi?.sessionId,
      sessionFile,
      unavailable: "The persisted session file is not a valid Pi transcript.",
    };
  }

  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  const component = renderNativeTranscript(buildContextEntries(entries), tui, header.cwd);
  return {
    component,
    sessionId: header.id,
    sessionFile,
  };
}

export function renderNativeTranscript(
  entries: readonly SessionEntry[],
  tui: TUI,
  cwd: string,
): Container {
  const transcript = new Container();
  const markdownTheme = getMarkdownTheme();
  const pendingTools = new Map<string, ToolExecutionComponent>();
  let hasContent = false;

  const add = (component: Parameters<Container["addChild"]>[0], spacer = false): void => {
    if (spacer && hasContent) transcript.addChild(new Spacer(1));
    transcript.addChild(component);
    hasContent = true;
  };

  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role === "assistant") {
        add(new AssistantMessageComponent(message, true, markdownTheme, "Thinking...", 1));
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
          add(tool);
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

      addNativeMessage(transcript, message, tui, markdownTheme, hasContent);
      hasContent = true;
    }
  }

  return transcript;
}

function addNativeMessage(
  transcript: Container,
  message: Exclude<AgentMessage, { role: "assistant" | "toolResult" }>,
  tui: TUI,
  markdownTheme: ReturnType<typeof getMarkdownTheme>,
  hasContent: boolean,
): void {
  switch (message.role) {
    case "user": {
      const text = userMessageText(message);
      if (!text) return;
      if (hasContent) transcript.addChild(new Spacer(1));
      const skill = parseSkillBlock(text);
      if (skill) {
        const invocation = new SkillInvocationMessageComponent(skill, markdownTheme);
        invocation.setExpanded(false);
        transcript.addChild(invocation);
        if (skill.userMessage) {
          transcript.addChild(new Spacer(1));
          transcript.addChild(new UserMessageComponent(skill.userMessage, markdownTheme, 1));
        }
      } else {
        transcript.addChild(new UserMessageComponent(text, markdownTheme, 1));
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
      transcript.addChild(component);
      return;
    }
    case "custom": {
      if (!message.display) return;
      const component = new CustomMessageComponent(message, undefined, markdownTheme);
      component.setExpanded(false);
      transcript.addChild(component);
      return;
    }
    case "compactionSummary": {
      if (hasContent) transcript.addChild(new Spacer(1));
      const component = new CompactionSummaryMessageComponent(message, markdownTheme);
      component.setExpanded(false);
      transcript.addChild(component);
      return;
    }
    case "branchSummary": {
      if (hasContent) transcript.addChild(new Spacer(1));
      const component = new BranchSummaryMessageComponent(message, markdownTheme);
      component.setExpanded(false);
      transcript.addChild(component);
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
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function transcriptFileEntries(source: string): readonly FileEntry[] {
  const entries = parseSessionEntries(source);
  migrateSessionEntries(entries);
  return entries;
}
