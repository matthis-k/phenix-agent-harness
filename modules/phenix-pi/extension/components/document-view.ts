import type { ListView } from "./list-view.ts";
import type { TerminalView } from "./terminal-view.ts";
import type { TreeView } from "./tree-view.ts";
import { fitViewLine } from "./viewport.ts";

export interface DocumentBlock {
  render(width: number): readonly string[];
}

export interface DocumentFrame {
  readonly width: number;
  readonly lines: readonly string[];
}

export interface DocumentRenderOptions {
  readonly trimEnd?: boolean;
}

export class DocumentView {
  private blocks: readonly DocumentBlock[];

  constructor(blocks: readonly DocumentBlock[] = []) {
    this.blocks = blocks;
  }

  setBlocks(blocks: readonly DocumentBlock[]): void {
    this.blocks = blocks;
  }

  render(width: number, options: DocumentRenderOptions = {}): DocumentFrame {
    const targetWidth = Math.max(0, Math.floor(width));
    const lines = this.blocks.flatMap((block) =>
      block.render(targetWidth).map((line) => {
        const fitted = fitViewLine(line, targetWidth);
        return options.trimEnd ? fitted.trimEnd() : fitted;
      }),
    );
    return { width: targetWidth, lines };
  }
}

export function textBlock(
  lines: readonly string[],
  options: { readonly paddingX?: number } = {},
): DocumentBlock {
  const paddingX = Math.max(0, Math.floor(options.paddingX ?? 0));
  return {
    render: (width) => {
      const contentWidth = Math.max(0, width - paddingX * 2);
      return lines.map(
        (line) =>
          `${" ".repeat(paddingX)}${fitViewLine(line, contentWidth)}${" ".repeat(paddingX)}`,
      );
    },
  };
}

export function spacerBlock(height = 1): DocumentBlock {
  const rows = Math.max(0, Math.floor(height));
  return { render: () => Array.from({ length: rows }, () => "") };
}

export function listBlock<T>(view: ListView<T>, focused = false): DocumentBlock {
  return {
    render: (width) => view.render(width, view.itemCount, focused).lines,
  };
}

export function treeBlock<T>(view: TreeView<T>, focused = false): DocumentBlock {
  return {
    render: (width) => view.render(width, view.itemCount, focused).lines,
  };
}

export function terminalBlock(view: TerminalView): DocumentBlock {
  return {
    render: (width) => view.render(width, view.lineCount).lines,
  };
}
