import { Container } from "@earendil-works/pi-tui";

import { DocumentView, textBlock } from "./components/document-view.ts";

export interface PresentationView {
  render(width: number): { readonly lines: readonly string[] };
}

export class PresentationComponent extends Container {
  private readonly view: PresentationView;

  constructor(view: PresentationView) {
    super();
    this.view = view;
  }

  override render(width: number): string[] {
    return [...this.view.render(width).lines];
  }

  override invalidate(): void {}
}

export function documentComponent(
  lines: readonly string[],
  options: { readonly paddingX?: number } = {},
): PresentationComponent {
  return new PresentationComponent(new DocumentView([textBlock(lines, options)]));
}
