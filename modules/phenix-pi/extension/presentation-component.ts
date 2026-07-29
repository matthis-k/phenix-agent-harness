import type { Component } from "@earendil-works/pi-tui";

import { DocumentView, textBlock } from "./components/document-view.ts";

export interface PresentationView {
  render(width: number): { readonly lines: readonly string[] };
}

export class PresentationComponent implements Component {
  private readonly view: PresentationView;

  constructor(view: PresentationView) {
    this.view = view;
  }

  render(width: number): string[] {
    return [...this.view.render(width).lines];
  }

  invalidate(): void {}
}

export function documentComponent(
  lines: readonly string[],
  options: { readonly paddingX?: number } = {},
): PresentationComponent {
  return new PresentationComponent(new DocumentView([textBlock(lines, options)]));
}
