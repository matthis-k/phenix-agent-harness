import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type Component, matchesKey, Text } from "@earendil-works/pi-tui";

import {
  createVisualizationArtifact,
  isVisualizationArtifact,
  VISUALIZATION_ENTRY_TYPE,
  VISUALIZATION_EVENT,
  type VisualizationArtifact,
} from "../domain/presentation/visualization.ts";
import { fitViewLine, renderPanel, TerminalView } from "./components/index.ts";
import { renderTerminalMermaid } from "./mermaid-rendering.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";

const VISUAL_ACCEPTED = "Visual accepted.";
const VISUALIZATION_ID_PREFIX = "visualization-";

export default function visualizationDisplay(pi: ExtensionAPI): void {
  const artifacts = new Map<string, VisualizationArtifact>();
  let rootSessionId = "root";

  pi.registerEntryRenderer<VisualizationArtifact>(
    VISUALIZATION_ENTRY_TYPE,
    (entry, _options, theme) => {
      const artifact = entry.data;
      if (!isVisualizationArtifact(artifact)) return new Text("", 0, 0);
      artifacts.set(artifact.visualizationId, artifact);
      try {
        const diagram = renderTerminalMermaid(artifact.source, {
          color: true,
          compact: true,
          theme,
        });
        return new Text(
          [
            theme.fg("accent", ` Diagram · ${artifact.title}`),
            theme.fg("muted", ` ${artifact.summary}`),
            "",
            diagram,
            "",
            theme.fg("muted", ` Open scrollable view: /visual ${artifact.visualizationId}`),
          ].join("\n"),
          1,
          0,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Text(
          [
            theme.fg("accent", ` Diagram · ${artifact.title}`),
            theme.fg("error", ` Unable to render Mermaid: ${message}`),
            theme.fg("muted", ` Open source: /visual ${artifact.visualizationId}`),
          ].join("\n"),
          1,
          0,
        );
      }
    },
  );

  pi.events.on(VISUALIZATION_EVENT, (value) => {
    if (!isVisualizationArtifact(value)) return;
    appendArtifact(pi, artifacts, value);
  });

  pi.on("session_start", (_event, ctx) => {
    rootSessionId = ctx.sessionManager.getSessionId();
    artifacts.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === VISUALIZATION_ENTRY_TYPE &&
        isVisualizationArtifact(entry.data)
      ) {
        artifacts.set(entry.data.visualizationId, entry.data);
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (event.isError || event.toolName !== "phenix_render_mermaid") return;
    const details = recordOf(event.details);
    const source = details?.source;
    if (typeof source !== "string") return;
    const artifact = createVisualizationArtifact({
      title: "Mermaid diagram",
      summary: "Visual explanation published by the active design session.",
      source,
      sourceSessionId: rootSessionId,
    });
    appendArtifact(pi, artifacts, artifact);
    return {
      content: [{ type: "text" as const, text: VISUAL_ACCEPTED }],
    };
  });

  pi.registerCommand("visual", {
    description: "Open a published Mermaid artifact; usage: /visual [visualization-id]",
    getArgumentCompletions: (prefix) => completeVisualizationIds(artifacts, prefix),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/visual requires interactive TUI mode.", "warning");
        return;
      }
      const artifact = resolveArtifact(artifacts, args);
      if (!artifact) {
        ctx.ui.notify(
          args.trim()
            ? `Unknown visualization ${args.trim()}.`
            : "No visual artifacts have been published in this transcript.",
          "warning",
        );
        return;
      }
      await ctx.ui.custom(
        (tui, theme, _keybindings, done) =>
          new VisualizationView({
            tui,
            theme,
            artifact,
            onClose: () => done(undefined),
          }),
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "top-left",
            margin: 0,
          },
        },
      );
    },
  });
}

export function completeVisualizationIds(
  artifacts: ReadonlyMap<string, VisualizationArtifact>,
  prefix: string,
): Array<{ readonly value: string; readonly label: string }> | null {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;
  const matches = [...artifacts.values()].reverse().filter((artifact) => {
    const id = artifact.visualizationId.toLowerCase();
    const shortId = id.startsWith(VISUALIZATION_ID_PREFIX)
      ? id.slice(VISUALIZATION_ID_PREFIX.length)
      : id;
    return !normalized || id.startsWith(normalized) || shortId.startsWith(normalized);
  });
  return matches.length > 0
    ? matches.map((artifact) => ({
        value: artifact.visualizationId,
        label: `${artifact.visualizationId} — ${artifact.title}`,
      }))
    : null;
}

function appendArtifact(
  pi: ExtensionAPI,
  artifacts: Map<string, VisualizationArtifact>,
  artifact: VisualizationArtifact,
): void {
  if (artifacts.has(artifact.visualizationId)) return;
  artifacts.set(artifact.visualizationId, artifact);
  pi.appendEntry(VISUALIZATION_ENTRY_TYPE, artifact);
}

function resolveArtifact(
  artifacts: ReadonlyMap<string, VisualizationArtifact>,
  selector: string,
): VisualizationArtifact | undefined {
  const values = [...artifacts.values()];
  const normalized = selector.trim().toLowerCase();
  if (!normalized) return values.at(-1);
  return [...values]
    .reverse()
    .find(
      (artifact) =>
        artifact.visualizationId.toLowerCase() === normalized ||
        artifact.visualizationId.toLowerCase().endsWith(normalized),
    );
}

export class VisualizationView implements Component {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly artifact: VisualizationArtifact;
  private readonly onClose: () => void;
  private readonly viewport = new TerminalView();

  constructor(input: {
    readonly tui: TUI;
    readonly theme: ObservabilityTheme;
    readonly artifact: VisualizationArtifact;
    readonly onClose: () => void;
  }) {
    this.tui = input.tui;
    this.theme = input.theme;
    this.artifact = input.artifact;
    this.onClose = input.onClose;
    try {
      this.viewport.setLines(
        renderTerminalMermaid(input.artifact.source, {
          color: true,
          compact: false,
          theme: input.theme,
        }).split("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.viewport.setLines([`Unable to render Mermaid: ${message}`, "", input.artifact.source]);
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onClose();
      return;
    }
    const bodyHeight = Math.max(1, this.tui.terminal.rows - 2);
    if (matchesKey(data, "left") || data === "h" || data === "H") {
      this.viewport.dispatch({ kind: "horizontal", columns: -4 }, bodyHeight);
    } else if (matchesKey(data, "right") || data === "l" || data === "L") {
      this.viewport.dispatch({ kind: "horizontal", columns: 4 }, bodyHeight);
    } else if (matchesKey(data, "up") || data === "k" || data === "K") {
      this.viewport.dispatch({ kind: "scroll", lines: -1 }, bodyHeight);
    } else if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.viewport.dispatch({ kind: "scroll", lines: 1 }, bodyHeight);
    } else if (matchesKey(data, "pageUp")) {
      this.viewport.dispatch({ kind: "page", direction: -1 }, bodyHeight);
    } else if (matchesKey(data, "pageDown")) {
      this.viewport.dispatch({ kind: "page", direction: 1 }, bodyHeight);
    } else if (matchesKey(data, "home") || data === "0") {
      this.viewport.dispatch({ kind: "home" }, bodyHeight);
      this.viewport.dispatch({ kind: "horizontal", columns: -Number.MAX_SAFE_INTEGER }, bodyHeight);
    } else if (matchesKey(data, "end") || data === "G") {
      this.viewport.dispatch({ kind: "end" }, bodyHeight);
      this.viewport.dispatch({ kind: "horizontal", columns: Number.MAX_SAFE_INTEGER }, bodyHeight);
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(5, this.tui.terminal.rows);
    const bodyHeight = Math.max(1, height - 2);
    const body = this.viewport.render(width, bodyHeight);
    const header = fitViewLine(
      `${this.theme.fg("accent", ` Diagram · ${this.artifact.title}`)} ${this.theme.fg("muted", `· ${this.artifact.visualizationId}`)}`,
      width,
    );
    const panel = renderPanel({
      lines: body.lines,
      width,
      height: height - 1,
      title: header,
      style: {
        surface: (line) => line,
        title: (title) => title,
      },
    });
    const footer = fitViewLine(
      this.theme.fg(
        "muted",
        " ↑↓/jk scroll · ←→/hl pan · PgUp/PgDn · Home/0 reset · End/G bottom-right · q close ",
      ),
      width,
    );
    return [...panel.lines, footer];
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
