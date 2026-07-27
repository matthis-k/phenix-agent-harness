import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";

import type {
  ResolvedResultRenderer,
  ResolvedResultTransform,
  ResultRenderInput,
} from "../application/result-presentation.ts";
import { renderTerminalMermaid } from "./mermaid-rendering.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";

const RESULT_ENTRY_TYPE = "phenix:result-display";
const ROOT_RESULT_TOOLS = new Set(["phenix_dispatch", "phenix_handle"]);

export interface NativeResultEntry {
  readonly content: string;
  readonly inputKind: ResultRenderInput["kind"];
  readonly renderer: Exclude<ResolvedResultRenderer, "tool">;
  readonly transform: ResolvedResultTransform;
  readonly steps: readonly string[];
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

export interface NativeResultRendererStrategy {
  readonly id: Exclude<ResolvedResultRenderer, "tool">;
  readonly inputKind: ResultRenderInput["kind"];
  render(content: string, theme: ObservabilityTheme): Markdown | Text;
}

export const defaultNativeResultRenderers: readonly NativeResultRendererStrategy[] = [
  {
    id: "pi-markdown",
    inputKind: "markdown",
    render: (content) => new Markdown(content, 1, 0, getMarkdownTheme()),
  },
  {
    id: "beautiful-mermaid",
    inputKind: "mermaid",
    render: (content, theme) =>
      new Text(renderTerminalMermaid(content, { color: true, compact: true, theme }), 1, 0),
  },
];

export default function resultDisplay(pi: ExtensionAPI): void {
  registerResultDisplay(pi, { renderers: defaultNativeResultRenderers });
}

export function registerResultDisplay(
  pi: ExtensionAPI,
  input: { readonly renderers: readonly NativeResultRendererStrategy[] },
): void {
  const renderers = rendererMap(input.renderers);

  pi.registerEntryRenderer<NativeResultEntry>(RESULT_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return new Text("", 0, 0);
    const renderer = renderers.get(data.renderer);
    if (!renderer || renderer.inputKind !== data.inputKind) {
      return new Text(
        theme.fg(
          "error",
          `Unable to render ${data.inputKind} result with ${data.renderer}: incompatible renderer`,
        ),
        1,
        0,
      );
    }
    try {
      return renderer.render(data.content, theme);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Text(
        theme.fg("error", `Unable to render ${data.inputKind} result: ${message}`),
        1,
        0,
      );
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (ctx.mode !== "tui") return;

    const entry = nativeResultEntry(event, pi.getActiveTools());
    if (!entry) return;

    pi.appendEntry(RESULT_ENTRY_TYPE, entry);
    return {
      content: [
        {
          type: "text" as const,
          text: `Result rendered with ${entry.renderer}.`,
        },
      ],
    };
  });
}

export function nativeResultEntry(
  event: ToolResultProjection,
  activeTools: readonly string[],
): NativeResultEntry | undefined {
  if (
    event.isError ||
    !activeTools.includes("phenix_dispatch") ||
    !ROOT_RESULT_TOOLS.has(event.toolName)
  ) {
    return undefined;
  }

  const presentation = presentationMetadata(event.details);
  if (!presentation || presentation.renderer === "tool") return undefined;

  const content = textContent(event.content);
  if (!content) return undefined;

  return {
    content,
    inputKind: presentation.inputKind,
    renderer: presentation.renderer,
    transform: presentation.transform,
    steps: presentation.steps,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };
}

function presentationMetadata(details: unknown):
  | {
      readonly transform: ResolvedResultTransform;
      readonly steps: readonly string[];
      readonly renderer: ResolvedResultRenderer;
      readonly inputKind: ResultRenderInput["kind"];
    }
  | undefined {
  const detailsRecord = recordOf(details);
  const transport = recordOf(detailsRecord?.transport);
  const presentation = recordOf(transport?.presentation);
  const transform = presentation?.transform;
  const renderer = presentation?.renderer;
  const inputKind = presentation?.inputKind;
  const steps = presentation?.steps;
  if (
    (transform !== "qa-report" &&
      transform !== "structured-content-markdown" &&
      transform !== "mermaid-source") ||
    (renderer !== "tool" && renderer !== "pi-markdown" && renderer !== "beautiful-mermaid") ||
    (inputKind !== "markdown" && inputKind !== "mermaid") ||
    !Array.isArray(steps) ||
    !steps.every((step): step is string => typeof step === "string")
  ) {
    return undefined;
  }
  return { transform, steps, renderer, inputKind };
}

function rendererMap(
  renderers: readonly NativeResultRendererStrategy[],
): ReadonlyMap<NativeResultRendererStrategy["id"], NativeResultRendererStrategy> {
  const map = new Map<NativeResultRendererStrategy["id"], NativeResultRendererStrategy>();
  for (const renderer of renderers) {
    if (map.has(renderer.id)) throw new Error(`Duplicate native result renderer ${renderer.id}`);
    map.set(renderer.id, renderer);
  }
  return map;
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
