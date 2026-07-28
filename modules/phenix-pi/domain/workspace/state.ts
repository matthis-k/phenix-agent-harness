import type { RunId } from "../shared.ts";

export type PaneId = "transcript" | "editor" | "runs" | "tasks" | "files" | "facts";
export type EffectId = string & { readonly __brand: "WorkspaceEffectId" };
export type ViewId = string & { readonly __brand: "WorkspaceViewId" };

export type ScrollState =
  | { readonly mode: "fixed"; readonly offset: number }
  | { readonly mode: "follow-end" };

export interface PaneState {
  readonly selectedItemId?: string;
  readonly collapsed: boolean;
  readonly scroll: ScrollState;
}

export interface TranscriptHandle {
  readonly key: string;
}

export type TranscriptAvailability =
  | { readonly kind: "ready"; readonly transcript: TranscriptHandle }
  | { readonly kind: "pending"; readonly requestId: EffectId; readonly runId: RunId }
  | { readonly kind: "not-applicable"; readonly reason: "workflow" | "root-projection" }
  | { readonly kind: "legacy"; readonly runId: RunId }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "invariant-violation"; readonly reason: string };

export interface TranscriptState {
  readonly runId: RunId;
  readonly availability: TranscriptAvailability;
  readonly scroll: ScrollState;
  readonly horizontalOrigin: 0;
}

export interface PendingEffect {
  readonly id: EffectId;
  readonly type: "snapshot.load" | "transcript.load";
  readonly sourceRevision: number;
  readonly owner: PaneId | "workspace";
}

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

export function createInitialWorkspaceState(rootRunId: RunId): WorkspaceState {
  return {
    revision: 0,
    snapshotRevision: 0,
    focusedPaneId: "editor",
    activeRunId: rootRunId,
    sidebarVisible: true,
    panes: {
      transcript: paneState({ mode: "follow-end" }),
      editor: paneState({ mode: "fixed", offset: 0 }),
      runs: paneState({ mode: "fixed", offset: 0 }, rootRunId),
      tasks: paneState({ mode: "fixed", offset: 0 }),
      files: paneState({ mode: "fixed", offset: 0 }),
      facts: paneState({ mode: "fixed", offset: 0 }),
    },
    transcript: {
      runId: rootRunId,
      availability: { kind: "not-applicable", reason: "root-projection" },
      scroll: { mode: "follow-end" },
      horizontalOrigin: 0,
    },
    pendingEffects: new Map(),
  };
}

function paneState(scroll: ScrollState, selectedItemId?: string): PaneState {
  return {
    ...(selectedItemId ? { selectedItemId: String(selectedItemId) } : {}),
    collapsed: false,
    scroll,
  };
}
