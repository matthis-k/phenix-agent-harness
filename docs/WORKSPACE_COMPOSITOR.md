# Workspace compositor architecture

Status: proposed target design. This document does not describe the current implementation until the migration is complete.

## Purpose

The default Phenix workspace must remain predictable while live run, task, fact, transcript, and file data changes asynchronously.

The architecture therefore optimizes for:

- local failure instead of workspace-wide corruption;
- pure layout and rendering;
- explicit side effects;
- stable identity instead of array-position coupling;
- bounded output at every component boundary;
- deterministic state transitions;
- testable invariants rather than visual convention;
- reuse by the default workspace and expanded `/phenix` views.

The workspace is not a second runtime. It is a projection and interaction layer over the canonical Phenix runtime and Pi session data.

## Current failure pattern

The current workspace component mixes:

- asynchronous snapshot refresh;
- transcript loading;
- selection and focus state;
- scroll state;
- layout allocation;
- mouse hit-region construction;
- terminal rendering;
- effect execution.

That coupling permits one update to invalidate assumptions held by another concern. Examples include stale hit regions after a resize, list indices pointing at different items after refresh, render-time state mutation, and a section allocating more rows than the terminal has available.

The target design prevents those classes of defects structurally.

## Architectural model

```text
Pi lifecycle and input
        |
        v
+----------------------+       +----------------------+
| Workspace controller |------>| Effect runtime       |
|                      |<------| transcript/load/open |
+----------+-----------+       +----------------------+
           |
           | immutable events
           v
+----------------------+
| Workspace reducer    |  pure
+----------+-----------+
           |
           | WorkspaceState
           v
+----------------------+       +----------------------+
| Projection registry  |------>| View models          |
|                      |  pure | runs/tasks/files/... |
+----------+-----------+       +----------------------+
           |
           v
+----------------------+
| Layout solver        |  pure
+----------+-----------+
           |
           | LayoutFrame
           v
+----------------------+
| View renderers       |  pure and bounded
+----------+-----------+
           |
           | RenderOutput[]
           v
+----------------------+
| Surface compositor   |  pure and clipping
+----------+-----------+
           |
           v
       Pi Component
```

Only the controller and effect runtime are stateful. The reducer, projections, layout solver, view renderers, and compositor are pure functions of their inputs.

## Dependency direction

```text
extension/workspace adapter
        -> application workspace controller
        -> domain workspace state and events
        -> ports for transcript, snapshot, and action effects

extension/render adapter
        -> application render orchestration
        -> domain layout/render contracts
```

Pi-specific components and terminal APIs stay in adapters. The workspace domain does not import Pi packages.

## Non-negotiable invariants

### State invariants

- `activeRunId`, `focusedPaneId`, and per-pane `selectedItemId` are distinct values.
- Selection is stored by stable ID, never by array index.
- Scroll state never uses sentinel values such as `Number.MAX_SAFE_INTEGER`.
- A snapshot has a monotonically increasing revision.
- An older snapshot or effect result cannot replace newer state.
- Every state transition occurs through the reducer.
- Rendering cannot mutate state.
- Effects cannot directly mutate state; they return events.

### Layout invariants

For any terminal size and layout specification:

- every visible pane has exactly one rectangle;
- all rectangle dimensions are non-negative;
- every rectangle lies inside terminal bounds;
- sibling rectangles do not overlap;
- gaps are included in the parent allocation;
- hidden or collapsed panes receive no rectangle;
- focus order contains visible, focusable panes only;
- the sum of child allocations never exceeds the parent allocation;
- unsatisfied constraints collapse panes deterministically by priority;
- hit regions are generated from the same layout frame used for rendering.

### Render invariants

- each view renders only within its assigned local rectangle;
- each rendered surface has exactly the assigned width and height;
- compositor output has exactly terminal height rows;
- every compositor row has visible width at most terminal width;
- clipping is performed by the surface abstraction, not independently by views;
- a render output contains zero or one cursor request;
- the compositor accepts at most one cursor globally;
- the cursor must be inside the focused pane;
- a view failure produces a bounded pane-local error view;
- one failed view cannot prevent sibling views from rendering.

### Effect invariants

- every effect has a stable request ID and source revision;
- effect completion is delivered as an event;
- stale completions are ignored by the reducer;
- effect failure is typed and scoped to its owner;
- cancellation occurs when the owning pane, run, or workspace is disposed;
- no effect executes during layout or rendering;
- repeated refresh signals are coalesced.

## Workspace state

```ts
export type PaneId =
  | "transcript"
  | "editor"
  | "runs"
  | "tasks"
  | "files"
  | "facts";

export interface WorkspaceState {
  readonly revision: number;
  readonly snapshotRevision: number;
  readonly focusedPaneId: PaneId;
  readonly activeRunId: RunId;
  readonly sidebarVisible: boolean;
  readonly panes: Readonly<Record<PaneId, PaneState>>;
  readonly transcript: TranscriptState;
  readonly pendingEffects: ReadonlyMap<EffectId, PendingEffect>;
}

export interface PaneState {
  readonly selectedItemId?: string;
  readonly collapsed: boolean;
  readonly scroll: ScrollState;
}

export type ScrollState =
  | { readonly mode: "fixed"; readonly offset: number }
  | { readonly mode: "follow-end" };
```

`follow-end` is a semantic state, not a large numeric offset.

## Workspace events and reducer

```ts
export type WorkspaceEvent =
  | { readonly type: "snapshot.received"; readonly snapshot: WorkspaceSnapshot }
  | { readonly type: "snapshot.failed"; readonly error: WorkspaceError }
  | { readonly type: "terminal.resized"; readonly size: Size }
  | { readonly type: "focus.move"; readonly direction: 1 | -1 }
  | { readonly type: "focus.set"; readonly paneId: PaneId }
  | { readonly type: "selection.set"; readonly paneId: PaneId; readonly itemId: string }
  | { readonly type: "selection.activate"; readonly paneId: PaneId }
  | { readonly type: "scroll.by"; readonly paneId: PaneId; readonly rows: number }
  | { readonly type: "scroll.home"; readonly paneId: PaneId }
  | { readonly type: "scroll.end"; readonly paneId: PaneId }
  | { readonly type: "section.toggle"; readonly paneId: PaneId }
  | { readonly type: "sidebar.toggle" }
  | { readonly type: "transcript.loaded"; readonly requestId: EffectId; readonly result: TranscriptResult }
  | { readonly type: "transcript.failed"; readonly requestId: EffectId; readonly error: WorkspaceError }
  | { readonly type: "mouse.input"; readonly layoutRevision: number; readonly event: MouseEvent };

export interface WorkspaceUpdate {
  readonly state: WorkspaceState;
  readonly effects: readonly WorkspaceEffect[];
}

export function reduceWorkspace(
  state: WorkspaceState,
  event: WorkspaceEvent,
): WorkspaceUpdate;
```

The reducer is total: every valid state/event pair returns a valid state. Invalid or stale inputs become a diagnostic effect and otherwise leave state unchanged.

## Explicit effects

```ts
export type WorkspaceEffect =
  | {
      readonly type: "snapshot.load";
      readonly requestId: EffectId;
      readonly sourceRevision: number;
    }
  | {
      readonly type: "transcript.load";
      readonly requestId: EffectId;
      readonly sourceRevision: number;
      readonly runId: RunId;
    }
  | {
      readonly type: "message.submit";
      readonly requestId: EffectId;
      readonly text: string;
      readonly delivery: "normal" | "steer";
    }
  | {
      readonly type: "inspector.open";
      readonly target: PhenixUiTarget;
    }
  | {
      readonly type: "native-ui.open";
      readonly editorText: string;
    }
  | {
      readonly type: "diagnostic.record";
      readonly error: WorkspaceError;
    };
```

Effects are interpreted by an injected runtime. Tests can execute the reducer without Pi, filesystem, timers, or terminal access.

## Error model

Errors are data with an owner and recovery scope.

```ts
export interface WorkspaceError {
  readonly code:
    | "snapshot-load-failed"
    | "transcript-load-failed"
    | "transcript-invalid"
    | "layout-unsatisfied"
    | "view-render-failed"
    | "stale-effect"
    | "invalid-input"
    | "invariant-violation";
  readonly owner:
    | { readonly kind: "workspace" }
    | { readonly kind: "pane"; readonly paneId: PaneId }
    | { readonly kind: "run"; readonly runId: RunId }
    | { readonly kind: "effect"; readonly effectId: EffectId };
  readonly message: string;
  readonly cause?: unknown;
  readonly recoverable: boolean;
}
```

Containment rules:

- transcript load errors replace only the transcript pane body;
- a sidebar projection error replaces only that sidebar section;
- a view render exception is caught by the compositor and becomes a pane-local error surface;
- a layout error falls back to a single-pane transcript/editor layout;
- snapshot load failure preserves the last valid snapshot and shows a bounded stale-data indicator;
- diagnostics never replace the canonical runtime event stream.

## Snapshot and projection boundary

The runtime adapter returns immutable source data. UI-specific rows are derived through pure projections.

```ts
export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly rootRunId: RunId;
  readonly runTree: RunTreeNode;
  readonly taskTree: TaskTree;
  readonly facts: readonly FactProjection[];
  readonly modifiedFiles: ModifiedFileSnapshot;
  readonly profile: SessionProfile;
  readonly diagnostics: DiagnosticSummary;
}
```

No projection stores mutable cursor or scroll data.

```ts
export interface WorkspaceProjection<T> {
  readonly id: string;
  project(snapshot: WorkspaceSnapshot, state: WorkspaceState): T;
}
```

Projection failures are isolated by registry entry.

## Stable selection reconciliation

When a snapshot changes:

1. Re-project items.
2. Preserve `selectedItemId` when it still exists.
3. Otherwise select the nearest surviving sibling using the previous ordering key.
4. Otherwise select the section's deterministic default.
5. Clamp the scroll state around the reconciled selected ID.

Array indexes are calculated only for rendering the current frame.

## Layout specification

```ts
export type LayoutNode =
  | PaneLayout
  | SplitLayout
  | StackLayout
  | ConditionalLayout;

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
```

The default workspace is a horizontal split between the conversation surface and sidebar. The conversation surface is a vertical split between transcript and editor. The sidebar is itself a vertically allocated registry of sections.

## Layout solver

```ts
export interface LayoutFrame {
  readonly revision: number;
  readonly terminal: Rect;
  readonly panes: ReadonlyMap<PaneId, Rect>;
  readonly focusOrder: readonly PaneId[];
  readonly collapsed: readonly PaneId[];
}

export function solveLayout(
  specification: LayoutNode,
  terminal: Rect,
  environment: LayoutEnvironment,
): Result<LayoutFrame, LayoutError>;
```

Solver algorithm:

1. Evaluate conditions.
2. Remove hidden nodes.
3. Reserve declared gaps.
4. Allocate every child's minimum.
5. If minimums do not fit, collapse candidates in descending collapse priority.
6. Distribute remaining space by weight while respecting maximums.
7. Re-distribute unused space until stable.
8. Emit absolute rectangles and focus order.
9. Validate all invariants before returning.

The solver never clamps a child after allocation in a way that leaves sibling geometry stale.

## Sidebar section registry

Runs, Tasks, Files, and Facts are registered sections rather than branches inside one renderer.

```ts
export interface SidebarSectionDescriptor<Item> {
  readonly id: SidebarSectionId;
  readonly title: (model: SidebarModel) => string;
  readonly weight: number;
  readonly minRows: number;
  readonly collapsePriority: number;
  readonly visible: (model: SidebarModel) => boolean;
  readonly items: (model: SidebarModel) => readonly Item[];
  readonly itemId: (item: Item) => string;
  readonly renderItem: (
    item: Item,
    context: SidebarItemRenderContext,
  ) => StyledLine;
  readonly activate?: (item: Item) => WorkspaceEffect;
}
```

Section allocation is a pure constrained operation:

```ts
export function allocateSidebarSections(
  availableRows: number,
  sections: readonly SidebarSectionConstraint[],
): readonly SidebarSectionFrame[];
```

The returned frames must sum to at most `availableRows`. A collapsed section receives exactly its header height. If even all headers do not fit, lower-priority sections become hidden.

## View contract

```ts
export interface WorkspaceView<Model, State> {
  readonly id: ViewId;

  measure(
    model: Model,
    state: State,
    constraints: Constraints,
  ): IntrinsicSize;

  render(
    model: Model,
    state: State,
    context: RenderContext,
  ): RenderOutput;
}

export interface RenderContext {
  readonly rect: Rect;
  readonly focused: boolean;
  readonly theme: WorkspaceTheme;
  readonly layoutRevision: number;
}

export interface RenderOutput {
  readonly surface: Surface;
  readonly cursor?: LocalCursor;
  readonly hitRegions: readonly LocalHitRegion[];
}
```

A view receives local coordinates only. It cannot inspect sibling geometry.

## Surface and compositor

```ts
export interface Surface {
  readonly width: number;
  readonly height: number;

  write(row: number, column: number, line: StyledLine): void;
  fill(rect: Rect, style: SurfaceStyle): void;
  blit(child: Surface, destination: Point): void;
  toLines(): readonly string[];
}
```

All writes clip. Negative or out-of-range coordinates become typed diagnostics in development and safe no-ops in production.

```ts
export interface CompositorResult {
  readonly lines: readonly string[];
  readonly cursor?: AbsoluteCursor;
  readonly hitMap: HitMap;
  readonly diagnostics: readonly WorkspaceError[];
}
```

The compositor:

1. creates a terminal-sized root surface;
2. renders each pane independently behind an error boundary;
3. validates each child output;
4. blits child surfaces into assigned rectangles;
5. converts local hit regions and cursor positions to absolute coordinates;
6. resolves the single cursor from the focused pane;
7. emits exact terminal-sized lines.

## Cursor, active item, selection, and focus

These concepts have separate visuals:

- `active`: the item whose content is displayed in the main pane;
- `selected`: the item an activation command would operate on;
- `focused`: the pane receiving keyboard input.

Run-row rendering rules:

- the active transcript run has a persistent active marker;
- the selected row has a persistent selected background even when unfocused;
- the selected row in the focused pane has the strongest background and bold text;
- the focused selected row requests the terminal cursor immediately before its selection marker;
- the root session is a real first row and is always selectable.

The cursor request is part of `RenderOutput`; views never write terminal escape sequences directly.

## Input and hit testing

Input parsing is separate from state mutation.

```ts
export type WorkspaceIntent =
  | { readonly type: "move"; readonly direction: "up" | "down" }
  | { readonly type: "page"; readonly direction: "up" | "down" }
  | { readonly type: "activate" }
  | { readonly type: "focus"; readonly direction: 1 | -1 }
  | { readonly type: "toggle-section" }
  | { readonly type: "toggle-sidebar" }
  | { readonly type: "open-root" }
  | { readonly type: "mouse"; readonly event: MouseEvent };
```

Mouse events carry the layout revision visible when input was captured. Events targeting an older frame are discarded. Hit testing operates only on the immutable `HitMap` produced by the compositor.

## Transcript model

Transcript availability is typed.

```ts
export type TranscriptAvailability =
  | { readonly kind: "ready"; readonly transcript: NativeTranscriptHandle }
  | { readonly kind: "pending"; readonly sessionId: string; readonly sessionFile?: string }
  | { readonly kind: "not-applicable"; readonly reason: "workflow" | "root-projection" }
  | { readonly kind: "legacy"; readonly runId: RunId }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "invariant-violation"; readonly reason: string };
```

Rules:

- an agent with a current Pi session but an unflushed file is `pending`;
- a workflow/container run is `not-applicable` rather than legacy;
- only persisted runs known to predate transcript support are `legacy`;
- a current agent with neither session ID nor file is an invariant violation;
- invalid JSONL is `invalid` and scoped to the selected run.

The native Pi transcript component remains the content renderer. A viewport adapter owns clipping and vertical scrolling.

```ts
export interface TranscriptViewportState {
  readonly scroll: ScrollState;
  readonly horizontalOrigin: 0;
}
```

Horizontal origin is fixed to zero. Selecting another transcript creates a fresh viewport state and cannot inherit horizontal position.

## Modified-file projection

Modified files are application data, not renderer state.

```ts
export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "unknown";

export interface ModifiedFileObservation {
  readonly runId: RunId;
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly source: "tool-event" | "change-set" | "working-tree-snapshot";
  readonly sequence: number;
}

export interface ModifiedFileProjection {
  readonly path: string;
  readonly statuses: readonly FileChangeStatus[];
  readonly contributors: readonly RunId[];
  readonly sources: readonly ModifiedFileObservation["source"][];
  readonly firstSequence: number;
  readonly lastSequence: number;
}
```

Queries expose explicit aggregation scope:

```ts
export interface ModifiedFileIndex {
  forRun(runId: RunId): readonly ModifiedFileProjection[];
  forSubtree(runId: RunId): readonly ModifiedFileProjection[];
  forRootSession(): readonly ModifiedFileProjection[];
}
```

The selected run's Files section uses `forSubtree(activeRunId)`. The root session uses the full session projection.

Attribution remains evidence-based. A working-tree snapshot proves that a path changed but may not prove which concurrent child changed it. The projection preserves sources and contributors rather than inventing certainty.

This model is the future input to a diff view. The diff renderer is not part of this migration.

## Refresh model

Runtime events do not directly render or load data.

```text
runtime event burst
  -> controller marks snapshot dirty
  -> one coalesced snapshot.load effect
  -> snapshot.received(revision N)
  -> reducer reconciles stable IDs and scroll state
  -> pure projection/layout/render
```

If another event arrives during a load, the controller schedules one additional load after completion. It does not create an unbounded queue.

The last valid snapshot remains visible while a refresh is pending or fails.

## Lifecycle ownership

- The root extension owns the Phenix runtime.
- The workspace extension owns the Pi custom workspace lifecycle.
- The workspace controller owns state transitions and effect scheduling.
- The effect runtime owns subscriptions, transcript reads, message submission, and inspector opening.
- Views own no external resources.
- Disposing the controller cancels pending effects and prevents later completions from publishing events.

## Public interfaces

The target package-local boundaries are:

```text
modules/phenix-pi/
  domain/workspace/
    geometry.ts
    layout.ts
    state.ts
    events.ts
    errors.ts
    render.ts

  application/workspace/
    controller.ts
    reducer.ts
    projections.ts
    modified-files.ts

  ports/
    workspace-effects.ts
    transcript-source.ts

  extension/workspace/
    pi-workspace-adapter.ts
    pi-effect-runtime.ts
    pi-native-transcript-view.ts
    input-adapter.ts
    theme-adapter.ts

  extension/workspace/views/
    transcript-view.ts
    editor-view.ts
    sidebar-view.ts
    run-section.ts
    task-section.ts
    file-section.ts
    fact-section.ts
```

Names may be adjusted during implementation, but ownership and dependency direction are fixed.

## Validation strategy

### Reducer tests

- all events preserve state invariants;
- stable-ID selection survives insertion and reordering;
- removed selections resolve deterministically;
- stale effect completions are ignored;
- selecting a new run resets transcript viewport state;
- the root run is always selectable;
- follow-end and fixed scroll transitions contain no sentinels.

### Layout property tests

Generate terminal dimensions, nested layout trees, min/max constraints, conditional visibility, and collapse priorities. Assert:

- no negative rectangles;
- no overlap;
- all rectangles inside bounds;
- deterministic output;
- total allocation within bounds;
- valid focus order;
- expected collapse ordering.

### Surface and compositor tests

- every write and blit clips;
- output has exact width and height;
- one failing view does not affect siblings;
- cursor lies inside the focused pane;
- stale layout hit maps are rejected;
- render functions do not mutate state.

### Projection tests

- root run is included first;
- completed subtree collapsing preserves active descendants;
- modified-file subtree union is deterministic;
- duplicate paths are normalized and merged;
- conflicting attribution remains represented;
- transcript states distinguish pending, not-applicable, legacy, invalid, and invariant violation.

### Integration tests

- runtime event bursts coalesce;
- resize during refresh cannot produce stale hit regions;
- switching child to root works by mouse and keyboard;
- transcript rendering remains left-origin after any sequence of switches and refreshes;
- short terminals never produce more rows than available;
- view failures remain pane-local;
- shutdown cancels effects and ignores late results.

## Migration plan

The migration is incremental and must keep the existing workspace usable between slices.

### Slice 1: contracts and pure primitives

Add geometry, state, event, error, layout, surface, and render contracts with property tests. No production behavior changes.

### Slice 2: reducer and controller

Move focus, selection, scroll, sidebar visibility, and refresh coalescing into the reducer/controller. Keep the existing renderer behind an adapter.

### Slice 3: layout solver and compositor

Replace render-time geometry mutation with immutable `LayoutFrame`, bounded surfaces, and revisioned hit maps.

### Slice 4: registered sidebar views

Extract Runs, Tasks, Files, and Facts into descriptors and independent view renderers. Add the root run row and distinct active/selected/focused visuals.

### Slice 5: transcript viewport and availability

Wrap Pi's native transcript component in the bounded viewport adapter. Introduce typed transcript availability and reset-on-selection semantics.

### Slice 6: modified-file projection

Add provenance-aware observations and subtree aggregation. Display the Files section without implementing a diff renderer.

### Slice 7: remove legacy workspace paths

Delete the old mutable layout, render-time section geometry, index-based selection, sentinel scrolling, and generic transcript warning.

Each slice requires canonical repository validation before the next begins.

## Rejected approaches

### More clamping inside the current renderer

Rejected because clamping after mutable layout decisions leaves dependent state and hit regions inconsistent.

### A global mutable workspace singleton

Rejected because Pi extension entry points can have isolated module contexts and because hidden shared state is difficult to test.

### Renderer-owned asynchronous loading

Rejected because render frequency and effect frequency are unrelated, and failures become difficult to localize.

### Array-index selection

Rejected because live projections insert, remove, and reorder items.

### Catching only at the outer Pi component

Rejected because one section failure would blank the entire workspace. Error boundaries belong at each view and effect owner.

### Generic horizontal transcript scrolling

Rejected for the current workspace. Native transcript content should wrap at the pane width and remain left-origin. Wide visual artifacts use their dedicated scrollable views.

## Completion criteria

The architecture is implemented when:

- the Pi-facing workspace class is a thin adapter around the controller;
- all state transitions pass through the reducer;
- layout and rendering are pure;
- side effects are represented as typed effects;
- all output is produced through bounded surfaces;
- hit testing is layout-revision aware;
- the root run is selectable;
- transcript state is typed and left-origin;
- modified files are projected by run subtree;
- failures are scoped to their pane, effect, or run;
- old mutable layout and render paths are removed;
- deterministic and property tests enforce the listed invariants.
