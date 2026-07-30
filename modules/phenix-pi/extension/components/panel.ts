import { fitViewLine } from "./viewport.ts";

export interface PanelRenderContext {
  readonly width: number;
  readonly row: number;
  readonly focused: boolean;
}

export interface PanelStyle {
  readonly surface: (line: string, context: PanelRenderContext) => string;
  readonly title?: (title: string, context: PanelRenderContext) => string;
}

export interface PanelInput {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  readonly focused?: boolean;
  readonly title?: string;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly style: PanelStyle;
}

export interface PanelFrame {
  readonly lines: string[];
  readonly contentWidth: number;
  readonly contentHeight: number;
}

export function renderPanel(input: PanelInput): PanelFrame {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const paddingX = Math.max(0, Math.floor(input.paddingX ?? 0));
  const paddingY = Math.max(0, Math.floor(input.paddingY ?? 0));
  const focused = input.focused ?? false;
  const titleRows = input.title === undefined ? 0 : 1;
  const contentWidth = Math.max(0, width - paddingX * 2);
  const contentHeight = Math.max(0, height - paddingY * 2 - titleRows);
  const content = input.lines.slice(0, contentHeight);

  const rows: string[] = [];
  for (let row = 0; row < paddingY; row += 1) rows.push("");
  if (input.title !== undefined) {
    const context = { width: contentWidth, row: rows.length, focused };
    rows.push(input.style.title?.(input.title, context) ?? input.title);
  }
  for (let row = 0; row < contentHeight; row += 1) rows.push(content[row] ?? "");
  while (rows.length < height - paddingY) rows.push("");
  for (let row = 0; row < paddingY && rows.length < height; row += 1) rows.push("");

  const lines = rows.slice(0, height).map((line, row) => {
    const inner = fitViewLine(line, contentWidth);
    const padded = `${" ".repeat(paddingX)}${inner}${" ".repeat(paddingX)}`;
    return input.style.surface(fitViewLine(padded, width), { width, row, focused });
  });
  return { lines, contentWidth, contentHeight };
}
