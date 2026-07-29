import { visibleWidth } from "@earendil-works/pi-tui";

import {
  ListView,
  type ListViewEvent,
  type ListViewFrame,
  type ListViewIntent,
} from "./list-view.ts";

export type TreeViewIntent =
  | ListViewIntent
  | { readonly kind: "toggle" }
  | { readonly kind: "expand" }
  | { readonly kind: "collapse" };

export type TreeViewEvent<T> =
  | { readonly kind: "selection"; readonly id: string; readonly node: T }
  | { readonly kind: "activate"; readonly id: string; readonly node: T }
  | {
      readonly kind: "expansion";
      readonly id: string;
      readonly node: T;
      readonly expanded: boolean;
    };

export interface TreeViewRenderContext {
  readonly width: number;
  readonly index: number;
  readonly depth: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly hasChildren: boolean;
}

export interface TreeViewAdapter<T> {
  readonly id: (node: T) => string;
  readonly children: (node: T) => readonly T[];
  readonly render: (node: T, context: TreeViewRenderContext) => string;
}

export interface TreeViewOptions {
  readonly wrapNavigation?: boolean;
  readonly indent?: string;
  readonly expandedMarker?: string;
  readonly collapsedMarker?: string;
  readonly leafMarker?: string;
}

export interface TreeViewFrame extends ListViewFrame {
  readonly visibleNodeIds: readonly string[];
}

interface TreeRow<T> {
  readonly id: string;
  readonly node: T;
  readonly depth: number;
  readonly parentId: string | undefined;
  readonly hasChildren: boolean;
}

export class TreeView<T> {
  private roots: readonly T[] = [];
  private rows: readonly TreeRow<T>[] = [];
  private readonly expanded = new Set<string>();
  private readonly list: ListView<TreeRow<T>>;
  private readonly indent: string;
  private readonly expandedMarker: string;
  private readonly collapsedMarker: string;
  private readonly leafMarker: string;

  constructor(
    private readonly adapter: TreeViewAdapter<T>,
    options: TreeViewOptions = {},
  ) {
    this.indent = options.indent ?? "  ";
    this.expandedMarker = options.expandedMarker ?? "▾";
    this.collapsedMarker = options.collapsedMarker ?? "▸";
    this.leafMarker = options.leafMarker ?? " ";
    this.list = new ListView<TreeRow<T>>(
      {
        id: (row) => row.id,
        render: (row, context) => this.renderRow(row, context),
      },
      { wrapNavigation: options.wrapNavigation },
    );
  }

  get selectedId(): string | undefined {
    return this.list.selectedId;
  }

  get selectedNode(): T | undefined {
    return this.list.selectedItem?.node;
  }

  get expandedIds(): ReadonlySet<string> {
    return new Set(this.expanded);
  }

  setRoots(roots: readonly T[]): void {
    this.roots = roots;
    this.rebuild();
  }

  setExpanded(ids: Iterable<string>): void {
    this.expanded.clear();
    for (const id of ids) this.expanded.add(id);
    this.rebuild();
  }

  setSelectedId(id: string | undefined): boolean {
    return this.list.setSelectedId(id);
  }

  dispatch(intent: TreeViewIntent, viewportHeight: number): TreeViewEvent<T> | undefined {
    if (intent.kind === "toggle" || intent.kind === "expand" || intent.kind === "collapse") {
      return this.dispatchExpansion(intent.kind);
    }
    return this.fromListEvent(this.list.dispatch(intent, viewportHeight));
  }

  render(width: number, height: number, focused = false): TreeViewFrame {
    const frame = this.list.render(width, height, focused);
    return { ...frame, visibleNodeIds: frame.visibleItemIds };
  }

  private dispatchExpansion(
    intent: "toggle" | "expand" | "collapse",
  ): TreeViewEvent<T> | undefined {
    const row = this.list.selectedItem;
    if (!row) return undefined;

    if (intent === "collapse" && !this.expanded.has(row.id)) {
      if (!row.parentId) return undefined;
      const event = this.list.dispatch({ kind: "select", id: row.parentId }, 1);
      return this.fromListEvent(event);
    }

    if (intent === "expand" && this.expanded.has(row.id)) {
      const child = this.rows.find((candidate) => candidate.parentId === row.id);
      if (!child) return undefined;
      return this.fromListEvent(this.list.dispatch({ kind: "select", id: child.id }, 1));
    }

    if (!row.hasChildren) return undefined;
    const expanded =
      intent === "toggle" ? !this.expanded.has(row.id) : intent === "expand";
    if (expanded) this.expanded.add(row.id);
    else this.expanded.delete(row.id);
    this.rebuild();
    return { kind: "expansion", id: row.id, node: row.node, expanded };
  }

  private rebuild(): void {
    this.rows = flattenTree(this.roots, this.adapter, this.expanded);
    this.list.setItems(this.rows);
  }

  private renderRow(
    row: TreeRow<T>,
    context: {
      readonly width: number;
      readonly index: number;
      readonly selected: boolean;
      readonly focused: boolean;
    },
  ): string {
    const marker = row.hasChildren
      ? this.expanded.has(row.id)
        ? this.expandedMarker
        : this.collapsedMarker
      : this.leafMarker;
    const prefix = `${this.indent.repeat(row.depth)}${marker} `;
    return `${prefix}${this.adapter.render(row.node, {
      ...context,
      width: Math.max(0, context.width - visibleWidth(prefix)),
      depth: row.depth,
      expanded: this.expanded.has(row.id),
      hasChildren: row.hasChildren,
    })}`;
  }

  private fromListEvent(event: ListViewEvent<TreeRow<T>> | undefined): TreeViewEvent<T> | undefined {
    if (!event) return undefined;
    return event.kind === "activate"
      ? { kind: "activate", id: event.id, node: event.item.node }
      : { kind: "selection", id: event.id, node: event.item.node };
  }
}

function flattenTree<T>(
  roots: readonly T[],
  adapter: TreeViewAdapter<T>,
  expanded: ReadonlySet<string>,
): readonly TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const seen = new Set<string>();

  const visit = (node: T, depth: number, parentId: string | undefined): void => {
    const id = adapter.id(node);
    if (seen.has(id)) throw new Error(`Tree node id must be unique: ${id}`);
    seen.add(id);
    const children = adapter.children(node);
    rows.push({ id, node, depth, parentId, hasChildren: children.length > 0 });
    if (!expanded.has(id)) return;
    for (const child of children) visit(child, depth + 1, id);
  };

  for (const root of roots) visit(root, 0, undefined);
  return rows;
}
