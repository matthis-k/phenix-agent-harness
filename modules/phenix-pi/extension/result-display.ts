import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";

import type {
  ResolvedResultDisplay,
  ResolvedResultTransform,
} from "../application/deterministic-presentation.ts";

const RESULT_ENTRY_TYPE = "phenix:result-display";

export interface NativeResultEntry {
  readonly content: string;
  readonly transform: ResolvedResultTransform;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ToolResultProjection {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly isError: boolean;
}

export default function resultDisplay(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<NativeResultEntry>(RESULT_ENTRY_TYPE, (entry) => {
    const data = entry.data;
    if (!data) return new Text("", 0, 0);
    return data.transform === "markdown"
      ? new Markdown(data.content, 1, 0, getMarkdownTheme())
      : new Text(data.content, 1, 0);
  });

  pi.on("tool_result", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    const entry = nativeResultEntry(event);
    if (!entry) return;

    pi.appendEntry(RESULT_ENTRY_TYPE, entry);
    return {
      content: [
        {
          type: "text" as const,
          text:
            entry.transform === "markdown"
              ? "Result displayed with Pi Markdown."
              : "Result displayed with Pi native text.",
        },
      ],
    };
  });
}

export function nativeResultEntry(event: ToolResultProjection): NativeResultEntry | undefined {
  if (event.isError) return undefined;

  const presentation = presentationMetadata(event.details);
  if (presentation?.display !== "native") return undefined;

  const content = textContent(event.content);
  if (!content) return undefined;

  return {
    content,
    transform: presentation.transform,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };
}

function presentationMetadata(
  details: unknown,
):
  | {
      readonly transform: ResolvedResultTransform;
      readonly display: ResolvedResultDisplay;
    }
  | undefined {
  const detailsRecord = recordOf(details);
  const transport = recordOf(detailsRecord?.transport);
  const presentation = recordOf(transport?.presentation);
  const transform = presentation?.transform;
  const display = presentation?.display;
  if (
    (transform !== "json" && transform !== "markdown") ||
    (display !== "tool" && display !== "native")
  ) {
    return undefined;
  }
  return { transform, display };
}

function textContent(content: readonly unknown[]): string | undefined {
  const text = content
    .flatMap((part) => {
      const record = recordOf(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
