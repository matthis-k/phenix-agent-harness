import type { TUI } from "@earendil-works/pi-tui";
import {
  type Component,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { AnyDefinition } from "../domain/definition/definition.ts";
import { renderCatalogDefinition } from "./mermaid-rendering.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";

type CatalogPane = "definitions" | "preview";

interface PreviewCache {
  readonly selectedIndex: number;
  readonly lines: readonly string[];
}

export interface CatalogBrowserOptions {
  readonly tui: TUI;
  readonly theme: ObservabilityTheme;
  readonly definitions: readonly AnyDefinition[];
  readonly initialDefinitionId?: string;
  readonly onClose: () => void;
}

export class CatalogBrowser implements Component {
  private readonly tui: TUI;
  private readonly theme: ObservabilityTheme;
  private readonly definitions: readonly AnyDefinition[];
  private readonly onClose: () => void;
  private selectedIndex: number;
  private activePane: CatalogPane = "definitions";
  private horizontalOffset = 0;
  private verticalOffset = 0;
  private maxHorizontalOffset = 0;
  private maxVerticalOffset = 0;
  private previewHeight = 1;
  private previewCache: PreviewCache | undefined;

  constructor(options: CatalogBrowserOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.definitions = options.definitions;
    this.onClose = options.onClose;
    const initialIndex = options.initialDefinitionId
      ? options.definitions.findIndex(
          (definition) => String(definition.id) === options.initialDefinitionId,
        )
      : -1;
    this.selectedIndex = initialIndex >= 0 ? initialIndex : 0;
  }

  invalidate(): void {
    // Preview output is theme-independent; only terminal dimensions affect the viewport.
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.activePane = this.activePane === "definitions" ? "preview" : "definitions";
      this.requestRender();
      return;
    }
    if (this.activePane === "definitions") {
      this.handleDefinitionInput(data);
      return;
    }
    this.handlePreviewInput(data);
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (width < 36 || height < 5) return this.renderNarrow(width, height);

    const sidebarWidth = Math.min(42, Math.max(24, Math.floor(width * 0.3)));
    const previewWidth = Math.max(1, width - sidebarWidth - 1);
    const bodyHeight = height - 3;
    this.previewHeight = bodyHeight;

    const previewLines = this.previewLines();
    const longestPreviewLine = previewLines.reduce(
      (longest, line) => Math.max(longest, visibleWidth(line)),
      0,
    );
    this.maxHorizontalOffset = Math.max(0, longestPreviewLine - previewWidth);
    this.maxVerticalOffset = Math.max(0, previewLines.length - bodyHeight);
    this.horizontalOffset = clamp(this.horizontalOffset, 0, this.maxHorizontalOffset);
    this.verticalOffset = clamp(this.verticalOffset, 0, this.maxVerticalOffset);

    const selected = this.selectedDefinition();
    const header = this.fitLine(
      this.theme.fg(
        "accent",
        this.theme.bold(` Phenix catalog · ${selected ? String(selected.id) : "no definitions"}`),
      ),
      width,
    );
    const rule = this.fitLine(this.theme.fg("dim", "─".repeat(width)), width);
    const sidebarLines = this.renderSidebar(sidebarWidth, bodyHeight);
    const body: string[] = [];
    for (let row = 0; row < bodyHeight; row += 1) {
      const source = previewLines[this.verticalOffset + row] ?? "";
      const preview = this.fitLine(
        sliceByColumn(source, this.horizontalOffset, previewWidth, true),
        previewWidth,
      );
      body.push(`${sidebarLines[row]}${this.theme.fg("dim", "│")}${preview}`);
    }
    const footer = this.fitLine(
      this.theme.fg(
        "muted",
        ` ${this.activePane === "definitions" ? "definitions" : "preview"} · Tab switch · arrows navigate/pan · PgUp/PgDn page · Home/End horizontal · Esc close · x ${this.horizontalOffset}/${this.maxHorizontalOffset} · y ${this.verticalOffset}/${this.maxVerticalOffset}`,
      ),
      width,
    );
    return [header, rule, ...body, footer];
  }

  private handleDefinitionInput(data: string): void {
    if (matchesKey(data, "up") || data === "k" || data === "K") {
      this.selectRelative(-1);
    } else if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.selectRelative(1);
    } else if (matchesKey(data, "pageUp")) {
      this.selectRelative(-Math.max(1, this.previewHeight - 2));
    } else if (matchesKey(data, "pageDown")) {
      this.selectRelative(Math.max(1, this.previewHeight - 2));
    } else if (matchesKey(data, "home")) {
      this.select(0);
    } else if (matchesKey(data, "end")) {
      this.select(this.definitions.length - 1);
    } else if (matchesKey(data, "right") || matchesKey(data, "enter")) {
      this.activePane = "preview";
      this.requestRender();
    }
  }

  private handlePreviewInput(data: string): void {
    const horizontalStep = 4;
    const verticalPage = Math.max(1, this.previewHeight - 2);
    if (matchesKey(data, "left") || data === "h" || data === "H") {
      this.horizontalOffset = clamp(
        this.horizontalOffset - horizontalStep,
        0,
        this.maxHorizontalOffset,
      );
    } else if (matchesKey(data, "right") || data === "l" || data === "L") {
      this.horizontalOffset = clamp(
        this.horizontalOffset + horizontalStep,
        0,
        this.maxHorizontalOffset,
      );
    } else if (matchesKey(data, "up") || data === "k" || data === "K") {
      this.verticalOffset = clamp(this.verticalOffset - 1, 0, this.maxVerticalOffset);
    } else if (matchesKey(data, "down") || data === "j" || data === "J") {
      this.verticalOffset = clamp(this.verticalOffset + 1, 0, this.maxVerticalOffset);
    } else if (matchesKey(data, "pageUp")) {
      this.verticalOffset = clamp(this.verticalOffset - verticalPage, 0, this.maxVerticalOffset);
    } else if (matchesKey(data, "pageDown")) {
      this.verticalOffset = clamp(this.verticalOffset + verticalPage, 0, this.maxVerticalOffset);
    } else if (matchesKey(data, "home")) {
      this.horizontalOffset = 0;
    } else if (matchesKey(data, "end")) {
      this.horizontalOffset = this.maxHorizontalOffset;
    } else {
      return;
    }
    this.requestRender();
  }

  private selectRelative(delta: number): void {
    if (this.definitions.length === 0) return;
    this.select((this.selectedIndex + delta + this.definitions.length) % this.definitions.length);
  }

  private select(index: number): void {
    if (this.definitions.length === 0) return;
    this.selectedIndex = clamp(index, 0, this.definitions.length - 1);
    this.horizontalOffset = 0;
    this.verticalOffset = 0;
    this.previewCache = undefined;
    this.requestRender();
  }

  private selectedDefinition(): AnyDefinition | undefined {
    return this.definitions[this.selectedIndex];
  }

  private previewLines(): readonly string[] {
    if (this.previewCache?.selectedIndex === this.selectedIndex) {
      return this.previewCache.lines;
    }
    const selected = this.selectedDefinition();
    const lines = selected
      ? this.renderPreview(selected)
      : ["No invokable definitions are available."];
    this.previewCache = { selectedIndex: this.selectedIndex, lines };
    return lines;
  }

  private renderPreview(selected: AnyDefinition): readonly string[] {
    try {
      return renderCatalogDefinition(selected).split("\n");
    } catch (error) {
      return [
        `${selected.id} — ${selected.title}`,
        "",
        `Unable to render definition: ${errorMessage(error)}`,
      ];
    }
  }

  private renderSidebar(width: number, height: number): string[] {
    if (this.definitions.length === 0) {
      return Array.from({ length: height }, (_, row) =>
        this.fitLine(row === 0 ? " No definitions" : "", width),
      );
    }
    const start = clamp(
      this.selectedIndex - Math.floor(height / 2),
      0,
      Math.max(0, this.definitions.length - height),
    );
    return Array.from({ length: height }, (_, row) => {
      const index = start + row;
      const definition = this.definitions[index];
      if (!definition) return " ".repeat(width);
      const selected = index === this.selectedIndex;
      const kind = definition.kind === "workflow" ? "W" : "A";
      const shortId = String(definition.id).replace(/^(?:agent|workflow)\./, "");
      const line = `${selected ? "→" : " "} ${kind} ${shortId}`;
      const styled = selected
        ? this.theme.fg(
            this.activePane === "definitions" ? "accent" : "text",
            this.theme.bold(line),
          )
        : this.theme.fg("muted", line);
      return this.fitLine(styled, width);
    });
  }

  private renderNarrow(width: number, height: number): string[] {
    const lines = [
      this.theme.fg("accent", this.theme.bold(" Phenix catalog")),
      this.theme.fg("warning", " Terminal is too small for the split catalog view."),
      " Resize to at least 36 columns and 5 rows.",
      " Esc closes the catalog.",
    ];
    return Array.from({ length: height }, (_, row) => this.fitLine(lines[row] ?? "", width));
  }

  private fitLine(line: string, width: number): string {
    const clipped = truncateToWidth(line, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
