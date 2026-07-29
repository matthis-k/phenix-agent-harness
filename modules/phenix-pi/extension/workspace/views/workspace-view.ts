import type { RunId } from "../../../domain/shared.ts";
import type { TaskTree } from "../../../domain/task/projection.ts";
import type { PaneId } from "../../../domain/workspace/state.ts";
import type { ObservabilityTheme } from "../../observability-theme.ts";
import type { PhenixUiSnapshot } from "../../phenix-ui.ts";

export const WORKSPACE_VIEW_IDS = ["runs", "tasks", "files", "facts"] as const;

export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];
export type WorkspaceViewPaneId = Extract<PaneId, WorkspaceViewId>;

export interface WorkspaceViewSnapshot {
  readonly ui: PhenixUiSnapshot;
  readonly tasks: TaskTree;
}

export interface WorkspaceViewContext {
  readonly selectedRunId?: RunId;
}

export interface WorkspaceViewRenderContext {
  readonly theme: ObservabilityTheme;
  readonly width: number;
  readonly activeRunId: RunId;
}

export interface WorkspaceViewRenderedRow {
  readonly text: string;
  readonly active?: boolean;
  readonly muted?: boolean;
}

export type WorkspaceViewActivation =
  | { readonly kind: "transcript"; readonly runId: RunId }
  | { readonly kind: "inspector"; readonly view: "facts" };

export interface WorkspaceViewLayout {
  readonly weight: number;
  readonly minRows: number;
  readonly headerRows: number;
  readonly collapsePriority: number;
}

export interface WorkspaceViewRow<TValue = unknown> {
  readonly id: string;
  readonly value: TValue;
  readonly activation?: WorkspaceViewActivation;
  render(context: WorkspaceViewRenderContext): WorkspaceViewRenderedRow;
}

export interface WorkspaceViewRegistration<TValue = unknown> {
  readonly id: WorkspaceViewPaneId;
  readonly title: string;
  readonly layout: WorkspaceViewLayout;
  project(
    snapshot: WorkspaceViewSnapshot,
    context?: WorkspaceViewContext,
  ): readonly WorkspaceViewRow<TValue>[];
}

export function defineWorkspaceView<TValue>(
  registration: WorkspaceViewRegistration<TValue>,
): WorkspaceViewRegistration<TValue> {
  return registration;
}
