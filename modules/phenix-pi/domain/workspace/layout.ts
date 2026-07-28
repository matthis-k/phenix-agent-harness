import { containsRect, intersects, rect, type Rect } from "./geometry.ts";
import type { PaneId, ViewId } from "./state.ts";

export type LayoutNode = PaneLayout | SplitLayout | StackLayout | ConditionalLayout;

export interface PaneLayout {
  readonly kind: "pane";
  readonly paneId: PaneId;
  readonly viewId: ViewId;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly collapsePriority?: number;
  readonly focusable?: boolean;
}

export interface SplitLayout {
  readonly kind: "split";
  readonly axis: "horizontal" | "vertical";
  readonly gap: number;
  readonly children: readonly SplitChild[];
}

export interface SplitChild {
  readonly node: LayoutNode;
  readonly weight: number;
  readonly min?: number;
  readonly max?: number;
}

export interface StackLayout {
  readonly kind: "stack";
  readonly activePaneId: PaneId;
  readonly children: readonly LayoutNode[];
}

export interface ConditionalLayout {
  readonly kind: "conditional";
  readonly predicate: LayoutPredicate;
  readonly then: LayoutNode;
  readonly otherwise?: LayoutNode;
}

export type LayoutPredicate =
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "min-width"; readonly width: number }
  | { readonly kind: "min-height"; readonly height: number }
  | { readonly kind: "all"; readonly predicates: readonly LayoutPredicate[] }
  | { readonly kind: "any"; readonly predicates: readonly LayoutPredicate[] }
  | { readonly kind: "not"; readonly predicate: LayoutPredicate };

export interface LayoutEnvironment {
  readonly revision: number;
  readonly flags: ReadonlySet<string>;
}

export interface LayoutFrame {
  readonly revision: number;
  readonly terminal: Rect;
  readonly panes: ReadonlyMap<PaneId, Rect>;
  readonly focusOrder: readonly PaneId[];
  readonly collapsed: readonly PaneId[];
}

export interface LayoutError {
  readonly code: "invalid-specification" | "unsatisfied-constraints" | "invariant-violation";
  readonly message: string;
}

export type LayoutResult =
  | { readonly ok: true; readonly value: LayoutFrame }
  | { readonly ok: false; readonly error: LayoutError };

interface Measurement {
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly collapsePriority?: number;
}

interface SolveContext {
  readonly terminal: Rect;
  readonly environment: LayoutEnvironment;
  readonly panes: Map<PaneId, Rect>;
  readonly focusOrder: PaneId[];
  readonly collapsed: Set<PaneId>;
}

interface ChildPlan {
  readonly child: SplitChild;
  readonly index: number;
  readonly measurement: Measurement;
  readonly minimum: number;
  readonly maximum: number;
  size: number;
}

export function solveLayout(
  specification: LayoutNode,
  terminal: Rect,
  environment: LayoutEnvironment,
): LayoutResult {
  const context: SolveContext = {
    terminal,
    environment,
    panes: new Map(),
    focusOrder: [],
    collapsed: new Set(),
  };
  const failure = solveNode(specification, terminal, context);
  if (failure) return { ok: false, error: failure };
  const frame: LayoutFrame = {
    revision: environment.revision,
    terminal,
    panes: context.panes,
    focusOrder: context.focusOrder,
    collapsed: [...context.collapsed],
  };
  const invalid = validateLayoutFrame(frame);
  return invalid ? { ok: false, error: invalid } : { ok: true, value: frame };
}

export function validateLayoutFrame(frame: LayoutFrame): LayoutError | undefined {
  const entries = [...frame.panes.entries()];
  for (const [paneId, bounds] of entries) {
    if (!containsRect(frame.terminal, bounds)) {
      return {
        code: "invariant-violation",
        message: `Pane ${paneId} lies outside the terminal bounds`,
      };
    }
  }
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const leftEntry = entries[left];
      const rightEntry = entries[right];
      if (leftEntry && rightEntry && intersects(leftEntry[1], rightEntry[1])) {
        return {
          code: "invariant-violation",
          message: `Panes ${leftEntry[0]} and ${rightEntry[0]} overlap`,
        };
      }
    }
  }
  const focus = new Set<PaneId>();
  for (const paneId of frame.focusOrder) {
    if (!frame.panes.has(paneId)) {
      return {
        code: "invariant-violation",
        message: `Focus order contains hidden pane ${paneId}`,
      };
    }
    if (focus.has(paneId)) {
      return {
        code: "invariant-violation",
        message: `Focus order contains duplicate pane ${paneId}`,
      };
    }
    focus.add(paneId);
  }
  for (const paneId of frame.collapsed) {
    if (frame.panes.has(paneId)) {
      return {
        code: "invariant-violation",
        message: `Collapsed pane ${paneId} is still visible`,
      };
    }
  }
  return undefined;
}

function solveNode(node: LayoutNode, bounds: Rect, context: SolveContext): LayoutError | undefined {
  if (node.kind === "conditional") {
    const branch = evaluatePredicate(node.predicate, context.terminal, context.environment)
      ? node.then
      : node.otherwise;
    return branch ? solveNode(branch, bounds, context) : undefined;
  }
  if (node.kind === "stack") {
    const active = node.children.find((child) =>
      collectPaneIds(child, context.terminal, context.environment).includes(node.activePaneId),
    );
    if (!active) {
      return {
        code: "invalid-specification",
        message: `Stack has no child containing active pane ${node.activePaneId}`,
      };
    }
    for (const child of node.children) {
      if (child === active) continue;
      for (const paneId of collectPaneIds(child, context.terminal, context.environment)) {
        context.collapsed.add(paneId);
      }
    }
    return solveNode(active, bounds, context);
  }
  if (node.kind === "pane") {
    const minWidth = positive(node.minWidth, 1);
    const minHeight = positive(node.minHeight, 1);
    if (bounds.width < minWidth || bounds.height < minHeight) {
      return {
        code: "unsatisfied-constraints",
        message: `Pane ${node.paneId} requires ${minWidth}x${minHeight}, received ${bounds.width}x${bounds.height}`,
      };
    }
    if (context.panes.has(node.paneId)) {
      return {
        code: "invalid-specification",
        message: `Pane ${node.paneId} appears more than once`,
      };
    }
    context.panes.set(node.paneId, bounds);
    if (node.focusable !== false) context.focusOrder.push(node.paneId);
    return undefined;
  }

  const gap = nonNegative(node.gap);
  if (gap === undefined) {
    return { code: "invalid-specification", message: "Split gap must be a non-negative integer" };
  }
  const axisLength = node.axis === "horizontal" ? bounds.width : bounds.height;
  const plans: ChildPlan[] = [];
  for (const [index, child] of node.children.entries()) {
    const measurement = measureNode(child.node, context.terminal, context.environment);
    if (!measurement) continue;
    const intrinsicMinimum = node.axis === "horizontal" ? measurement.minWidth : measurement.minHeight;
    const intrinsicMaximum = node.axis === "horizontal" ? measurement.maxWidth : measurement.maxHeight;
    const minimum = Math.max(nonNegative(child.min) ?? 0, intrinsicMinimum);
    const maximum = Math.min(nonNegative(child.max) ?? Number.POSITIVE_INFINITY, intrinsicMaximum);
    if (maximum < minimum || child.weight < 0 || !Number.isFinite(child.weight)) {
      return {
        code: "invalid-specification",
        message: `Split child ${index} has invalid weight or min/max constraints`,
      };
    }
    plans.push({ child, index, measurement, minimum, maximum, size: minimum });
  }

  collapseUntilFits(plans, axisLength, gap, context);
  if (requiredLength(plans, gap) > axisLength) {
    return {
      code: "unsatisfied-constraints",
      message: `Split requires ${requiredLength(plans, gap)} cells, received ${axisLength}`,
    };
  }

  allocateRemaining(plans, axisLength - gap * Math.max(0, plans.length - 1));
  let cursor = node.axis === "horizontal" ? bounds.x : bounds.y;
  for (const plan of plans) {
    const childBounds =
      node.axis === "horizontal"
        ? rect(cursor, bounds.y, plan.size, bounds.height)
        : rect(bounds.x, cursor, bounds.width, plan.size);
    const failure = solveNode(plan.child.node, childBounds, context);
    if (failure) return failure;
    cursor += plan.size + gap;
  }
  return undefined;
}

function collapseUntilFits(
  plans: ChildPlan[],
  available: number,
  gap: number,
  context: SolveContext,
): void {
  while (requiredLength(plans, gap) > available) {
    const candidate = [...plans]
      .filter((plan) => plan.measurement.collapsePriority !== undefined)
      .sort(
        (left, right) =>
          (right.measurement.collapsePriority ?? 0) -
            (left.measurement.collapsePriority ?? 0) ||
          right.index - left.index,
      )[0];
    if (!candidate) return;
    for (const paneId of collectPaneIds(
      candidate.child.node,
      context.terminal,
      context.environment,
    )) {
      context.collapsed.add(paneId);
    }
    plans.splice(plans.indexOf(candidate), 1);
  }
}

function allocateRemaining(plans: ChildPlan[], usable: number): void {
  let remaining = Math.max(0, usable - plans.reduce((sum, plan) => sum + plan.size, 0));
  while (remaining > 0) {
    const eligible = plans.filter((plan) => plan.size < plan.maximum);
    if (eligible.length === 0) return;
    const totalWeight = eligible.reduce((sum, plan) => sum + plan.child.weight, 0);
    let assigned = 0;
    for (const plan of eligible) {
      const weighted = totalWeight > 0 ? Math.floor((remaining * plan.child.weight) / totalWeight) : 0;
      const requested = Math.max(1, weighted);
      const delta = Math.min(requested, plan.maximum - plan.size, remaining - assigned);
      if (delta <= 0) continue;
      plan.size += delta;
      assigned += delta;
      if (assigned === remaining) break;
    }
    if (assigned === 0) return;
    remaining -= assigned;
  }
}

function requiredLength(plans: readonly ChildPlan[], gap: number): number {
  return (
    plans.reduce((sum, plan) => sum + plan.minimum, 0) + gap * Math.max(0, plans.length - 1)
  );
}

function measureNode(
  node: LayoutNode,
  terminal: Rect,
  environment: LayoutEnvironment,
): Measurement | undefined {
  if (node.kind === "conditional") {
    const branch = evaluatePredicate(node.predicate, terminal, environment)
      ? node.then
      : node.otherwise;
    return branch ? measureNode(branch, terminal, environment) : undefined;
  }
  if (node.kind === "stack") {
    const active = node.children.find((child) =>
      collectPaneIds(child, terminal, environment).includes(node.activePaneId),
    );
    return active ? measureNode(active, terminal, environment) : undefined;
  }
  if (node.kind === "pane") {
    return {
      minWidth: positive(node.minWidth, 1),
      minHeight: positive(node.minHeight, 1),
      maxWidth: positive(node.maxWidth, Number.POSITIVE_INFINITY),
      maxHeight: positive(node.maxHeight, Number.POSITIVE_INFINITY),
      collapsePriority: node.collapsePriority,
    };
  }
  const gap = nonNegative(node.gap) ?? 0;
  const children = node.children
    .map((child) => measureNode(child.node, terminal, environment))
    .filter((value): value is Measurement => value !== undefined);
  if (children.length === 0) {
    return {
      minWidth: 0,
      minHeight: 0,
      maxWidth: 0,
      maxHeight: 0,
      collapsePriority: nodeCollapsePriority(node, terminal, environment),
    };
  }
  const gaps = gap * Math.max(0, children.length - 1);
  if (node.axis === "horizontal") {
    return {
      minWidth: children.reduce((sum, child) => sum + child.minWidth, gaps),
      minHeight: Math.max(...children.map((child) => child.minHeight)),
      maxWidth: sumMaximum(children.map((child) => child.maxWidth), gaps),
      maxHeight: Math.min(...children.map((child) => child.maxHeight)),
      collapsePriority: nodeCollapsePriority(node, terminal, environment),
    };
  }
  return {
    minWidth: Math.max(...children.map((child) => child.minWidth)),
    minHeight: children.reduce((sum, child) => sum + child.minHeight, gaps),
    maxWidth: Math.min(...children.map((child) => child.maxWidth)),
    maxHeight: sumMaximum(children.map((child) => child.maxHeight), gaps),
    collapsePriority: nodeCollapsePriority(node, terminal, environment),
  };
}

function collectPaneIds(
  node: LayoutNode,
  terminal: Rect,
  environment: LayoutEnvironment,
): readonly PaneId[] {
  if (node.kind === "pane") return [node.paneId];
  if (node.kind === "conditional") {
    const branch = evaluatePredicate(node.predicate, terminal, environment)
      ? node.then
      : node.otherwise;
    return branch ? collectPaneIds(branch, terminal, environment) : [];
  }
  if (node.kind === "stack") {
    const active = node.children.find((child) =>
      collectPaneIds(child, terminal, environment).includes(node.activePaneId),
    );
    return active ? collectPaneIds(active, terminal, environment) : [];
  }
  return node.children.flatMap((child) => collectPaneIds(child.node, terminal, environment));
}

function nodeCollapsePriority(
  node: LayoutNode,
  terminal: Rect,
  environment: LayoutEnvironment,
): number | undefined {
  if (node.kind === "pane") return node.collapsePriority;
  const priorities = collectPaneIds(node, terminal, environment).flatMap((paneId) => {
    const pane = findPane(node, paneId, terminal, environment);
    return pane?.collapsePriority === undefined ? [] : [pane.collapsePriority];
  });
  return priorities.length > 0 ? Math.max(...priorities) : undefined;
}

function findPane(
  node: LayoutNode,
  paneId: PaneId,
  terminal: Rect,
  environment: LayoutEnvironment,
): PaneLayout | undefined {
  if (node.kind === "pane") return node.paneId === paneId ? node : undefined;
  if (node.kind === "conditional") {
    const branch = evaluatePredicate(node.predicate, terminal, environment)
      ? node.then
      : node.otherwise;
    return branch ? findPane(branch, paneId, terminal, environment) : undefined;
  }
  return node.children
    .map((child) => findPane("node" in child ? child.node : child, paneId, terminal, environment))
    .find((value) => value !== undefined);
}

function evaluatePredicate(
  predicate: LayoutPredicate,
  terminal: Rect,
  environment: LayoutEnvironment,
): boolean {
  if (predicate.kind === "flag") return environment.flags.has(predicate.flag);
  if (predicate.kind === "min-width") return terminal.width >= predicate.width;
  if (predicate.kind === "min-height") return terminal.height >= predicate.height;
  if (predicate.kind === "all") {
    return predicate.predicates.every((item) => evaluatePredicate(item, terminal, environment));
  }
  if (predicate.kind === "any") {
    return predicate.predicates.some((item) => evaluatePredicate(item, terminal, environment));
  }
  return !evaluatePredicate(predicate.predicate, terminal, environment);
}

function sumMaximum(values: readonly number[], initial: number): number {
  return values.some((value) => !Number.isFinite(value))
    ? Number.POSITIVE_INFINITY
    : values.reduce((sum, value) => sum + value, initial);
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export interface SidebarSectionConstraint {
  readonly id: string;
  readonly weight: number;
  readonly minRows: number;
  readonly collapsePriority: number;
  readonly collapsed: boolean;
  readonly visible?: boolean;
  readonly headerRows?: number;
}

export interface SidebarSectionFrame {
  readonly id: string;
  readonly start: number;
  readonly height: number;
  readonly collapsed: boolean;
  readonly hidden: boolean;
}

export function allocateSidebarSections(
  availableRows: number,
  sections: readonly SidebarSectionConstraint[],
): readonly SidebarSectionFrame[] {
  const available = Math.max(0, Math.floor(availableRows));
  const plans = sections.map((section, index) => {
    const header = Math.max(1, Math.floor(section.headerRows ?? 1));
    const minimum = Math.max(header, Math.floor(section.minRows));
    const hidden = section.visible === false;
    return {
      section,
      index,
      header,
      minimum,
      collapsed: section.collapsed,
      hidden,
      height: hidden ? 0 : section.collapsed ? header : minimum,
    };
  });

  const total = (): number => plans.reduce((sum, plan) => sum + plan.height, 0);
  for (const plan of [...plans]
    .filter((item) => !item.hidden && !item.collapsed)
    .sort(
      (left, right) =>
        right.section.collapsePriority - left.section.collapsePriority || right.index - left.index,
    )) {
    if (total() <= available) break;
    plan.collapsed = true;
    plan.height = plan.header;
  }
  for (const plan of [...plans]
    .filter((item) => !item.hidden)
    .sort(
      (left, right) =>
        right.section.collapsePriority - left.section.collapsePriority || right.index - left.index,
    )) {
    if (total() <= available) break;
    plan.hidden = true;
    plan.height = 0;
  }

  let remaining = Math.max(0, available - total());
  while (remaining > 0) {
    const eligible = plans.filter(
      (plan) => !plan.hidden && !plan.collapsed && plan.section.weight > 0,
    );
    if (eligible.length === 0) break;
    const totalWeight = eligible.reduce((sum, plan) => sum + plan.section.weight, 0);
    let assigned = 0;
    for (const plan of eligible) {
      const share = Math.max(1, Math.floor((remaining * plan.section.weight) / totalWeight));
      const delta = Math.min(share, remaining - assigned);
      plan.height += delta;
      assigned += delta;
      if (assigned === remaining) break;
    }
    if (assigned === 0) break;
    remaining -= assigned;
  }

  let start = 0;
  return plans.map((plan) => {
    const frame: SidebarSectionFrame = {
      id: plan.section.id,
      start,
      height: plan.height,
      collapsed: plan.collapsed,
      hidden: plan.hidden,
    };
    start += plan.height;
    return frame;
  });
}
