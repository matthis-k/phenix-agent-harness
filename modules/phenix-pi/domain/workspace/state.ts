import type { RunId } from "../shared.ts";

export type PaneId = "runs" | "objectives" | "files" | "facts" | "transcript" | "input";
export type PaneGroup = "sidebar" | "transcript";
export type ScrollMode = "fixed" | "follow-end";

export interface PaneScroll {
  readonly vertical: number;
  readonly horizontal: number;
  readonly mode: ScrollMode;
}

export interface PaneState {
  readonly id: PaneId;
  readonly selectedId?: string;
  readonly scroll: PaneScroll;
}

export interface WorkspaceState {
  readonly revision: number;
  readonly selectedRunId: RunId;
  readonly activeRunId?: RunId;
  readonly focusedGroup: PaneGroup;
  readonly focusedPane: PaneId;
  readonly panes: Readonly<Record<PaneId, PaneState>>;
}

export type WorkspaceAction =
  | { readonly kind: "select-run"; readonly runId: RunId }
  | { readonly kind: "set-active-run"; readonly runId?: RunId }
  | { readonly kind: "focus-group"; readonly group: PaneGroup }
  | { readonly kind: "focus-pane"; readonly pane: PaneId }
  | { readonly kind: "select-item"; readonly pane: PaneId; readonly id?: string }
  | { readonly kind: "scroll"; readonly pane: PaneId; readonly lines: number }
  | { readonly kind: "horizontal"; readonly pane: PaneId; readonly columns: number }
  | { readonly kind: "set-scroll-mode"; readonly pane: PaneId; readonly mode: ScrollMode }
  | { readonly kind: "snapshot-applied"; readonly availableRunIds: ReadonlySet<RunId> };

export function createWorkspaceState(rootRunId: RunId): WorkspaceState {
  return {
    revision: 0,
    selectedRunId: rootRunId,
    focusedGroup: "transcript",
    focusedPane: "input",
    panes: {
      runs: pane("runs"),
      objectives: pane("objectives"),
      files: pane("files"),
      facts: pane("facts"),
      transcript: pane("transcript", "follow-end"),
      input: pane("input"),
    },
  };
}

export function reduceWorkspaceState(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.kind) {
    case "select-run":
      return changed(state, {
        selectedRunId: action.runId,
        panes: updatePane(state.panes, "runs", (paneState) => ({
          ...paneState,
          selectedId: String(action.runId),
        })),
      });
    case "set-active-run":
      return changed(state, { activeRunId: action.runId });
    case "focus-group":
      return changed(state, {
        focusedGroup: action.group,
        focusedPane: action.group === "sidebar" ? "runs" : "input",
      });
    case "focus-pane":
      return changed(state, {
        focusedGroup: groupFor(action.pane),
        focusedPane: action.pane,
      });
    case "select-item":
      return changed(state, {
        panes: updatePane(state.panes, action.pane, (paneState) => ({
          ...paneState,
          selectedId: action.id,
        })),
      });
    case "scroll":
      return changed(state, {
        panes: updatePane(state.panes, action.pane, (paneState) => ({
          ...paneState,
          scroll: {
            ...paneState.scroll,
            vertical: Math.max(0, paneState.scroll.vertical + action.lines),
            ...(action.pane === "transcript" && action.lines < 0 ? { mode: "fixed" as const } : {}),
          },
        })),
      });
    case "horizontal":
      return changed(state, {
        panes: updatePane(state.panes, action.pane, (paneState) => ({
          ...paneState,
          scroll: {
            ...paneState.scroll,
            horizontal: Math.max(0, paneState.scroll.horizontal + action.columns),
          },
        })),
      });
    case "set-scroll-mode":
      return changed(state, {
        panes: updatePane(state.panes, action.pane, (paneState) => ({
          ...paneState,
          scroll: { ...paneState.scroll, mode: action.mode },
        })),
      });
    case "snapshot-applied": {
      if (action.availableRunIds.has(state.selectedRunId)) return state;
      const fallback = action.availableRunIds.has(state.activeRunId as RunId)
        ? state.activeRunId
        : [...action.availableRunIds][0];
      return fallback ? changed(state, { selectedRunId: fallback }) : state;
    }
  }
}

function pane(id: PaneId, mode: ScrollMode = "fixed"): PaneState {
  return { id, scroll: { vertical: 0, horizontal: 0, mode } };
}

function groupFor(paneId: PaneId): PaneGroup {
  return paneId === "input" || paneId === "transcript" ? "transcript" : "sidebar";
}

function changed(state: WorkspaceState, patch: Partial<WorkspaceState>): WorkspaceState {
  return { ...state, ...patch, revision: state.revision + 1 };
}

function updatePane(
  panes: Readonly<Record<PaneId, PaneState>>,
  paneId: PaneId,
  update: (pane: PaneState) => PaneState,
): Readonly<Record<PaneId, PaneState>> {
  return { ...panes, [paneId]: update(panes[paneId]) };
}
