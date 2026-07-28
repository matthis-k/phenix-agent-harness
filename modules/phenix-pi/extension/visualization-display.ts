import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  type Component,
  matchesKey,
  sliceByColumn,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  isVisualizationArtifact,
  type VisualizationArtifact,
  VISUALIZATION_ENTRY_TYPE,
  VISUALIZATION_EVENT,
} from "../domain/presentation/visualization.ts";
import { renderTerminalMermaid } from "./mermaid-rendering.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";

export default function visualizationDisplay(pi: ExtensionAPI): void {
  const artifacts = new Map<string, VisualizationArtifact>();

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
    if (!isVisualizationArtifact(value) || artifacts.has(value.visualizationId)) return;
    artifacts.set(value.visualizationId, value);
    pi.appendEntry(VISUALIZATION_ENTRY_TYPE, value);
  });

  pi.on("session_start", (_event, ctx) => {
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

  pi.registerCommand("visual", {
    description: "Open a published Mermaid artifact; usage: /visual [visualization-id]",
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
  private readonly lines: readonly string[];
  private horizontalOffset = 0;
  private verticalOffset = 0;

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
      this.lines = renderTerminalMermaid(input.artifact.source, {
        color: true,
        compact: false,
        theme: input.theme,
      }).split("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lines = [`Unable to render Mermaid: ${message}`, "", input.artifact.source];
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onClose();
      return;
    }
    const page = Math.max(1, this.tui.terminal.rows - 6);
    if (matchesKey(data, "left") || data === "h" || data === "H") {
      this.horizontalOffset = Math.max(0, this.horizontalOffset - 4);
    } else if (matchesKey(data, "right") || data === "l" || data === "L") {
      this.horizontalOffset += 4;
    } else if (matchesKey(data, "up") || data === "k" || data === "K") {
      this.verticalOffset = Math.max(0, this.verticalOffset - 1);
    } else if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.verticalOffset += 1;
    } else if (matchesKey(data, "pageUp")) {
      this.verticalOffset = Math.max(0, this.verticalOffset - page);
    } else if (matchesKey(data, "pageDown")) {
      this.verticalOffset += page;
    } else if (matchesKey(data, "home") || data === "0") {
      this.horizontalOffset = 0;
      this.verticalOffset = 0;
    } else if (matchesKey(data, "end") || data === "G") {
      this.horizontalOffset = Number.MAX_SAFE_INTEGER;
      this.verticalOffset = Number.MAX_SAFE_INTEGER;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(5, this.tui.terminal.rows);
    const bodyHeight = Math.max(1, height - 3);
    const longest = this.lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0);
    this.horizontalOffset = clamp(this.horizontalOffset, 0, Math.max(0, longest - width));
    this.verticalOffset = clamp(
      this.verticalOffset,
      0,
      Math.max(0, this.lines.length - bodyHeight),
    );
    const header = this.fit(
      `${this.theme.fg("accent", ` Diagram · ${this.artifact.title}`)} ${this.theme.fg("muted", `· ${this.artifact.visualizationId}`)}`,
      width,
    );
    const body = Array.from({ length: bodyHeight }, (_, row) => {
      const source = this.lines[this.verticalOffset + row] ?? "";
      return this.fit(sliceByColumn(source, this.horizontalOffset, width, true), width);
    });
    const footer = this.fit(
      this.theme.fg(
        "muted",
        " ↑↓/jk scroll · ←→/hl pan · PgUp/PgDn · Home/0 reset · End/G bottom-right · q close ",
      ),
      width,
    );
    return [header, ...body, footer];
  }

  private fit(line: string, width: number): string {
    const clipped = truncateToWidth(line, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
