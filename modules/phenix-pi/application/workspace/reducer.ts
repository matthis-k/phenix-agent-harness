import type { RunId } from "../../domain/shared.ts";
import type {
  WorkspaceEffect,
  WorkspaceEvent,
  WorkspaceItemIndex,
} from "../../domain/workspace/events.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type {
  EffectId,
  PaneId,
  PaneState,
  ScrollState,
  WorkspaceState,
} from "../../domain/workspace/state.ts";

export interface WorkspaceUpdate {
  readonly state: WorkspaceState;
  readonly effects: readonly WorkspaceEffect[];
}

const PANE_IDS: readonly PaneId[] = ["transcript", "editor", "runs", "tasks", "files", "facts"];
const COLLAPSIBLE_PANES = new Set<PaneId>(["runs", "tasks", "files", "facts"]);

export function reduceWorkspace<TSnapshot>(
  state: WorkspaceState,
  event: WorkspaceEvent<TSnapshot>,
): WorkspaceUpdate {
  switch (event.type) {
    case "snapshot.requested":
      return requestEffect(state, event.requestId, "snapshot.load", "workspace", {
        type: "snapshot.load",
        requestId: event.requestId,
        sourceRevision: state.revision,
      });
    case "snapshot.received":
      return receiveSnapshot(state, event);
    case "snapshot.failed":
      return failEffect(state, event.requestId, event.error);
    case "focus.move":
      return moveFocus(state, event.order, event.direction);
    case "focus.set":
      return update(state, { focusedPaneId: event.paneId });
    case "selection.set":
      return updatePane(state, event.paneId, (pane) => ({ ...pane, selectedItemId: event.itemId }));
    case "selection.move":
      return moveSelection(state, event.paneId, event.itemIds, event.direction);
    case "selection.edge":
      return selectEdge(state, event.paneId, event.itemIds, event.edge);
    case "scroll.set":
      return setScroll(state, event.paneId, event.scroll);
    case "scroll.by":
      return scrollBy(state, event.paneId, event.rows);
    case "scroll.home":
      return setScroll(state, event.paneId, { mode: "fixed", offset: 0 });
    case "scroll.end":
      return setScroll(state, event.paneId, { mode: "follow-end" });
    case "section.toggle":
      return toggleSection(state, event.paneId);
    case "sidebar.toggle":
      return update(state, { sidebarVisible: !state.sidebarVisible });
    case "transcript.requested":
      return requestTranscript(state, event.requestId, event.runId);
    case "transcript.loaded":
      return receiveTranscript(state, event.requestId, event.runId, event.handle);
    case "transcript.failed":
      return failTranscript(state, event.requestId, event.runId, event.error);
    case "terminal.resized":
    case "selection.activate":
    case "mouse.input":
      return unchanged(state);
  }
}

function receiveSnapshot<TSnapshot>(
  state: WorkspaceState,
  event: Extract<WorkspaceEvent<TSnapshot>, { type: "snapshot.received" }>,
): WorkspaceUpdate {
  const pending = state.pendingEffects.get(event.requestId);
  if (pending?.type !== "snapshot.load") return staleEffect(state, event.requestId);

  const pendingEffects = withoutEffect(state.pendingEffects, event.requestId);
  if (event.snapshot.revision < state.snapshotRevision) {
    return commit(
      { ...state, pendingEffects },
      [diagnostic(staleError(event.requestId, "Snapshot completion is older than current state"))],
    );
  }

  const panes = reconcilePanes(state.panes, event.previousItemIds, event.snapshot.itemIds);
  const runIds = event.snapshot.itemIds.runs;
  const activeRunId = runIds.includes(String(state.activeRunId))
    ? state.activeRunId
    : event.snapshot.rootRunId;
  const activeChanged = activeRunId !== state.activeRunId;

  return commit({
    ...state,
    snapshotRevision: event.snapshot.revision,
    activeRunId,
    panes,
    transcript: activeChanged
      ? {
          runId: activeRunId,
          availability: { kind: "not-applicable", reason: "root-projection" },
          scroll: { mode: "follow-end" },
          horizontalOrigin: 0,
        }
      : state.transcript,
    pendingEffects,
  });
}

function moveFocus(
  state: WorkspaceState,
  order: readonly PaneId[],
  direction: 1 | -1,
): WorkspaceUpdate {
  const visible = [...new Set(order)];
  if (visible.length === 0) {
    return withDiagnostic(state, invalidInput("Focus order must contain at least one pane"));
  }
  const current = visible.indexOf(state.focusedPaneId);
  const index = current >= 0 ? current : 0;
  const focusedPaneId = visible[(index + direction + visible.length) % visible.length];
  return focusedPaneId ? update(state, { focusedPaneId }) : unchanged(state);
}

function moveSelection(
  state: WorkspaceState,
  paneId: PaneId,
  itemIds: readonly string[],
  direction: 1 | -1,
): WorkspaceUpdate {
  if (itemIds.length === 0) return clearSelection(state, paneId);
  const current = state.panes[paneId].selectedItemId;
  const index = current ? itemIds.indexOf(current) : -1;
  const next = clamp(index < 0 ? (direction > 0 ? 0 : itemIds.length - 1) : index + direction, 0, itemIds.length - 1);
  const selectedItemId = itemIds[next];
  return selectedItemId
    ? updatePane(state, paneId, (pane) => ({ ...pane, selectedItemId }))
    : unchanged(state);
}

function selectEdge(
  state: WorkspaceState,
  paneId: PaneId,
  itemIds: readonly string[],
  edge: "first" | "last",
): WorkspaceUpdate {
  if (itemIds.length === 0) return clearSelection(state, paneId);
  const selectedItemId = edge === "first" ? itemIds[0] : itemIds.at(-1);
  return selectedItemId
    ? updatePane(state, paneId, (pane) => ({ ...pane, selectedItemId }))
    : unchanged(state);
}

function setScroll(state: WorkspaceState, paneId: PaneId, scroll: ScrollState): WorkspaceUpdate {
  if (scroll.mode === "fixed" && (!Number.isInteger(scroll.offset) || scroll.offset < 0)) {
    return withDiagnostic(state, invalidInput("Fixed scroll offsets must be non-negative integers"));
  }
  return updatePane(state, paneId, (pane) => ({ ...pane, scroll }));
}

function scrollBy(state: WorkspaceState, paneId: PaneId, rows: number): WorkspaceUpdate {
  if (!Number.isInteger(rows)) return withDiagnostic(state, invalidInput("Scroll delta must be an integer"));
  const current = state.panes[paneId].scroll;
  if (current.mode === "follow-end") {
    return rows >= 0
      ? unchanged(state)
      : setScroll(state, paneId, { mode: "fixed", offset: Math.abs(rows) });
  }
  return setScroll(state, paneId, {
    mode: "fixed",
    offset: Math.max(0, current.offset + rows),
  });
}

function toggleSection(state: WorkspaceState, paneId: PaneId): WorkspaceUpdate {
  if (!COLLAPSIBLE_PANES.has(paneId)) {
    return withDiagnostic(state, invalidInput(`Pane ${paneId} cannot be collapsed`));
  }
  return updatePane(state, paneId, (pane) => ({ ...pane, collapsed: !pane.collapsed }));
}

function requestTranscript(
  state: WorkspaceState,
  requestId: EffectId,
  runId: RunId,
): WorkspaceUpdate {
  const requested = requestEffectState(state, requestId, "transcript.load", "transcript");
  const runs = {
    ...requested.panes.runs,
    selectedItemId: String(runId),
  };
  const next: WorkspaceState = {
    ...requested,
    activeRunId: runId,
    panes: { ...requested.panes, runs },
    transcript: {
      runId,
      availability: { kind: "pending", requestId, runId },
      scroll: { mode: "follow-end" },
      horizontalOrigin: 0,
    },
  };
  return commit(next, [
    {
      type: "transcript.load",
      requestId,
      sourceRevision: state.revision,
      runId,
    },
  ]);
}

function receiveTranscript(
  state: WorkspaceState,
  requestId: EffectId,
  runId: RunId,
  handle: { readonly key: string },
): WorkspaceUpdate {
  if (!isCurrentTranscriptRequest(state, requestId, runId)) return staleEffect(state, requestId);
  return commit({
    ...state,
    transcript: {
      ...state.transcript,
      availability: { kind: "ready", transcript: handle },
    },
    pendingEffects: withoutEffect(state.pendingEffects, requestId),
  });
}

function failTranscript(
  state: WorkspaceState,
  requestId: EffectId,
  runId: RunId,
  error: WorkspaceError,
): WorkspaceUpdate {
  if (!isCurrentTranscriptRequest(state, requestId, runId)) return staleEffect(state, requestId);
  return commit(
    {
      ...state,
      transcript: {
        ...state.transcript,
        availability: { kind: "invalid", reason: error.message },
      },
      pendingEffects: withoutEffect(state.pendingEffects, requestId),
    },
    [diagnostic(error)],
  );
}

function failEffect(
  state: WorkspaceState,
  requestId: EffectId,
  error: WorkspaceError,
): WorkspaceUpdate {
  if (!state.pendingEffects.has(requestId)) return staleEffect(state, requestId);
  return commit(
    { ...state, pendingEffects: withoutEffect(state.pendingEffects, requestId) },
    [diagnostic(error)],
  );
}

function requestEffect(
  state: WorkspaceState,
  requestId: EffectId,
  type: "snapshot.load" | "transcript.load",
  owner: PaneId | "workspace",
  effect: WorkspaceEffect,
): WorkspaceUpdate {
  return commit(requestEffectState(state, requestId, type, owner), [effect]);
}

function requestEffectState(
  state: WorkspaceState,
  requestId: EffectId,
  type: "snapshot.load" | "transcript.load",
  owner: PaneId | "workspace",
): WorkspaceState {
  const pendingEffects = new Map(state.pendingEffects);
  pendingEffects.set(requestId, {
    id: requestId,
    type,
    sourceRevision: state.revision,
    owner,
  });
  return { ...state, pendingEffects };
}

function isCurrentTranscriptRequest(
  state: WorkspaceState,
  requestId: EffectId,
  runId: RunId,
): boolean {
  const pending = state.pendingEffects.get(requestId);
  return (
    pending?.type === "transcript.load" &&
    state.transcript.runId === runId &&
    state.transcript.availability.kind === "pending" &&
    state.transcript.availability.requestId === requestId
  );
}

function reconcilePanes(
  panes: Readonly<Record<PaneId, PaneState>>,
  previous: WorkspaceItemIndex,
  next: WorkspaceItemIndex,
): Readonly<Record<PaneId, PaneState>> {
  return Object.fromEntries(
    PANE_IDS.map((paneId) => [
      paneId,
      {
        ...panes[paneId],
        ...selectedProperty(
          reconcileSelection(
            panes[paneId].selectedItemId,
            previous[paneId],
            next[paneId],
          ),
        ),
      },
    ]),
  ) as Readonly<Record<PaneId, PaneState>>;
}

export function reconcileSelection(
  selectedItemId: string | undefined,
  previousItemIds: readonly string[],
  nextItemIds: readonly string[],
): string | undefined {
  if (nextItemIds.length === 0) return undefined;
  if (selectedItemId && nextItemIds.includes(selectedItemId)) return selectedItemId;
  const previousIndex = selectedItemId ? previousItemIds.indexOf(selectedItemId) : -1;
  const target = previousIndex < 0 ? 0 : Math.min(previousIndex, nextItemIds.length - 1);
  return nextItemIds[target];
}

function clearSelection(state: WorkspaceState, paneId: PaneId): WorkspaceUpdate {
  return updatePane(state, paneId, (pane) => {
    const { selectedItemId: _selectedItemId, ...remaining } = pane;
    return remaining;
  });
}

function selectedProperty(selectedItemId: string | undefined): { readonly selectedItemId?: string } {
  return selectedItemId ? { selectedItemId } : {};
}

function updatePane(
  state: WorkspaceState,
  paneId: PaneId,
  transform: (pane: PaneState) => PaneState,
): WorkspaceUpdate {
  const pane = transform(state.panes[paneId]);
  return update(state, { panes: { ...state.panes, [paneId]: pane } });
}

function update(state: WorkspaceState, patch: Partial<WorkspaceState>): WorkspaceUpdate {
  return commit({ ...state, ...patch });
}

function commit(state: WorkspaceState, effects: readonly WorkspaceEffect[] = []): WorkspaceUpdate {
  return { state: { ...state, revision: state.revision + 1 }, effects };
}

function unchanged(state: WorkspaceState): WorkspaceUpdate {
  return { state, effects: [] };
}

function withoutEffect(
  pendingEffects: ReadonlyMap<EffectId, unknown>,
  requestId: EffectId,
): ReadonlyMap<EffectId, WorkspaceState["pendingEffects"] extends ReadonlyMap<EffectId, infer T> ? T : never> {
  const next = new Map(pendingEffects as WorkspaceState["pendingEffects"]);
  next.delete(requestId);
  return next;
}

function staleEffect(state: WorkspaceState, requestId: EffectId): WorkspaceUpdate {
  return withDiagnostic(state, staleError(requestId, "Effect completion is no longer current"));
}

function withDiagnostic(state: WorkspaceState, error: WorkspaceError): WorkspaceUpdate {
  return { state, effects: [diagnostic(error)] };
}

function diagnostic(error: WorkspaceError): WorkspaceEffect {
  return { type: "diagnostic.record", error };
}

function staleError(effectId: EffectId, message: string): WorkspaceError {
  return {
    code: "stale-effect",
    owner: { kind: "effect", effectId },
    message,
    recoverable: true,
  };
}

function invalidInput(message: string): WorkspaceError {
  return {
    code: "invalid-input",
    owner: { kind: "workspace" },
    message,
    recoverable: true,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
