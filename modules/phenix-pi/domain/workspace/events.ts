import type { RunId } from "../shared.ts";
import type { WorkspaceError } from "./errors.ts";
import type { Size } from "./geometry.ts";
import type {
  EffectId,
  PaneId,
  ScrollState,
  SettledTranscriptAvailability,
} from "./state.ts";

export type WorkspaceItemIndex = Readonly<Record<PaneId, readonly string[]>>;

export interface WorkspaceSnapshotEnvelope<TSnapshot> {
  readonly revision: number;
  readonly rootRunId: RunId;
  readonly itemIds: WorkspaceItemIndex;
  readonly value: TSnapshot;
}

export interface WorkspaceMouseEvent {
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}

export type WorkspaceEvent<TSnapshot = unknown> =
  | { readonly type: "snapshot.requested"; readonly requestId: EffectId }
  | {
      readonly type: "snapshot.received";
      readonly requestId: EffectId;
      readonly previousItemIds: WorkspaceItemIndex;
      readonly snapshot: WorkspaceSnapshotEnvelope<TSnapshot>;
    }
  | {
      readonly type: "snapshot.failed";
      readonly requestId: EffectId;
      readonly error: WorkspaceError;
    }
  | { readonly type: "terminal.resized"; readonly size: Size }
  | { readonly type: "focus.move"; readonly direction: 1 | -1; readonly order: readonly PaneId[] }
  | { readonly type: "focus.set"; readonly paneId: PaneId }
  | { readonly type: "selection.set"; readonly paneId: PaneId; readonly itemId: string }
  | {
      readonly type: "selection.move";
      readonly paneId: PaneId;
      readonly direction: 1 | -1;
      readonly itemIds: readonly string[];
    }
  | {
      readonly type: "selection.edge";
      readonly paneId: PaneId;
      readonly edge: "first" | "last";
      readonly itemIds: readonly string[];
    }
  | { readonly type: "selection.activate"; readonly paneId: PaneId }
  | { readonly type: "scroll.set"; readonly paneId: PaneId; readonly scroll: ScrollState }
  | { readonly type: "scroll.by"; readonly paneId: PaneId; readonly rows: number }
  | { readonly type: "scroll.home"; readonly paneId: PaneId }
  | { readonly type: "scroll.end"; readonly paneId: PaneId }
  | { readonly type: "section.toggle"; readonly paneId: PaneId }
  | { readonly type: "sidebar.toggle" }
  | {
      readonly type: "transcript.requested";
      readonly requestId: EffectId;
      readonly runId: RunId;
    }
  | {
      readonly type: "transcript.loaded";
      readonly requestId: EffectId;
      readonly runId: RunId;
      readonly availability: SettledTranscriptAvailability;
    }
  | {
      readonly type: "transcript.failed";
      readonly requestId: EffectId;
      readonly runId: RunId;
      readonly error: WorkspaceError;
    }
  | {
      readonly type: "mouse.input";
      readonly layoutRevision: number;
      readonly event: WorkspaceMouseEvent;
    };

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
      readonly view: "status" | "runs" | "facts" | "catalog";
      readonly selector?: string;
    }
  | { readonly type: "native-ui.open"; readonly editorText: string }
  | { readonly type: "diagnostic.record"; readonly error: WorkspaceError };
