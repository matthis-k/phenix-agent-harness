import { fitViewLine, keepIndexVisible } from "./viewport.ts";

export type ListViewIntent =
  | { readonly kind: "move"; readonly direction: 1 | -1 }
  | { readonly kind: "page"; readonly direction: 1 | -1 }
  | { readonly kind: "edge"; readonly edge: "first" | "last" }
  | { readonly kind: "select"; readonly id: string }
  | { readonly kind: "activate" };

export type ListViewEvent<T> =
  | { readonly kind: "selection"; readonly id: string; readonly item: T }
  | { readonly kind: "activate"; readonly id: string; readonly item: T };

export interface ListViewRenderContext {
  readonly width: number;
  readonly index: number;
  readonly selected: boolean;
  readonly focused: boolean;
}

export interface ListViewAdapter<T> {
  readonly id: (item: T) => string;
  readonly render: (item: T, context: ListViewRenderContext) => string;
}

export interface ListViewOptions {
  readonly wrapNavigation?: boolean;
  readonly selectFirstItem?: boolean;
  readonly renderEmpty?: (width: number) => string;
}

export interface ListViewportState {
  readonly selectedId: string | undefined;
  readonly offset: number;
}

export interface ListViewFrame extends ListViewportState {
  readonly lines: readonly string[];
  readonly visibleItemIds: readonly string[];
}

export class ListView<T> {
  private readonly adapter: ListViewAdapter<T>;
  private items: readonly T[] = [];
  private selectedItemId: string | undefined;
  private offset = 0;
  private readonly wrapNavigation: boolean;
  private readonly selectFirstItem: boolean;
  private readonly renderEmpty: (width: number) => string;

  constructor(adapter: ListViewAdapter<T>, options: ListViewOptions = {}) {
    this.adapter = adapter;
    this.wrapNavigation = options.wrapNavigation ?? false;
    this.selectFirstItem = options.selectFirstItem ?? true;
    this.renderEmpty = options.renderEmpty ?? (() => "");
  }

  get selectedId(): string | undefined {
    return this.selectedItemId;
  }

  get selectedItem(): T | undefined {
    return this.itemById(this.selectedItemId);
  }

  get itemCount(): number {
    return this.items.length;
  }

  get viewport(): ListViewportState {
    return { selectedId: this.selectedItemId, offset: this.offset };
  }

  setItems(items: readonly T[]): void {
    this.items = items;
    if (this.selectedItemId && this.itemById(this.selectedItemId)) return;
    this.selectedItemId = this.selectFirstItem ? this.itemIdAt(0) : undefined;
    this.offset = 0;
  }

  setViewport(state: ListViewportState): void {
    this.offset = Math.max(0, Math.floor(state.offset));
    this.setSelectedId(state.selectedId);
  }

  setSelectedId(id: string | undefined): boolean {
    if (id === undefined) {
      if (this.selectedItemId === undefined) return false;
      this.selectedItemId = undefined;
      return true;
    }
    if (!this.itemById(id) || this.selectedItemId === id) return false;
    this.selectedItemId = id;
    return true;
  }

  dispatch(intent: ListViewIntent, viewportHeight: number): ListViewEvent<T> | undefined {
    if (intent.kind === "activate") {
      const item = this.selectedItem;
      if (!item) return undefined;
      return { kind: "activate", id: this.adapter.id(item), item };
    }

    if (this.items.length === 0) return undefined;
    const current = this.selectedIndex();
    let next = current;
    switch (intent.kind) {
      case "move":
        next = this.moveIndex(current, intent.direction);
        break;
      case "page":
        next = clampIndex(
          current + intent.direction * Math.max(1, viewportHeight),
          this.items.length,
        );
        break;
      case "edge":
        next = intent.edge === "first" ? 0 : this.items.length - 1;
        break;
      case "select": {
        const index = this.items.findIndex((item) => this.adapter.id(item) === intent.id);
        if (index < 0) return undefined;
        next = index;
        break;
      }
    }

    const item = this.items[next];
    if (!item) return undefined;
    const id = this.adapter.id(item);
    this.selectedItemId = id;
    this.offset = keepIndexVisible(this.offset, next, viewportHeight, this.items.length);
    return { kind: "selection", id, item };
  }

  render(width: number, height: number, focused = false): ListViewFrame {
    const viewportHeight = Math.max(0, Math.floor(height));
    const selectedIndex = this.selectedIndex();
    this.offset = keepIndexVisible(this.offset, selectedIndex, viewportHeight, this.items.length);
    const visible = this.items.slice(this.offset, this.offset + viewportHeight);
    const lines = Array.from({ length: viewportHeight }, (_, row) => {
      const item = visible[row];
      if (!item) {
        return fitViewLine(
          this.items.length === 0 && row === 0 ? this.renderEmpty(width) : "",
          width,
        );
      }
      const index = this.offset + row;
      return fitViewLine(
        this.adapter.render(item, {
          width,
          index,
          selected: this.adapter.id(item) === this.selectedItemId,
          focused,
        }),
        width,
      );
    });
    return {
      lines,
      offset: this.offset,
      selectedId: this.selectedItemId,
      visibleItemIds: visible.map((item) => this.adapter.id(item)),
    };
  }

  private selectedIndex(): number {
    if (this.items.length === 0) return 0;
    const index = this.selectedItemId
      ? this.items.findIndex((item) => this.adapter.id(item) === this.selectedItemId)
      : -1;
    return index >= 0 ? index : 0;
  }

  private moveIndex(index: number, direction: 1 | -1): number {
    if (!this.wrapNavigation) return clampIndex(index + direction, this.items.length);
    return (index + direction + this.items.length) % this.items.length;
  }

  private itemById(id: string | undefined): T | undefined {
    return id === undefined ? undefined : this.items.find((item) => this.adapter.id(item) === id);
  }

  private itemIdAt(index: number): string | undefined {
    const item = this.items[index];
    return item ? this.adapter.id(item) : undefined;
  }
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}
