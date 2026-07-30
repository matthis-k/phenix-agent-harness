import type { RunFact } from "../../../domain/run/observability.ts";
import type { RunId } from "../../../domain/shared.ts";
import type { TaskTree } from "../../../domain/task/projection.ts";
import type { PaneId } from "../../../domain/workspace/state.ts";
import { workspaceSurface } from "../../../domain/workspace/surfaces.ts";
import type { RunTree } from "../../interfaces.ts";
import type { WorkspaceRowPresentation } from "../presentation.ts";

export const WORKSPACE_VIEW_IDS = ["runs", "tasks", "files", "facts"] as const;

export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];
export type WorkspaceViewPaneId = Extract<PaneId, WorkspaceViewId>;

export interface WorkspaceViewSnapshot {
  readonly ui: {
    readonly tree: RunTree;
    readonly facts: readonly RunFact[];
  };
  readonly tasks: TaskTree;
}

export interface WorkspaceViewContext {
  readonly selectedRunId?: RunId;
}

export interface WorkspaceViewPresentationContext {
  readonly width: number;
  readonly activeRunId: RunId;
  readonly expanded: boolean;
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
  readonly expandable?: boolean;
  present(context: WorkspaceViewPresentationContext): WorkspaceRowPresentation;
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

export function workspaceViewLayout(id: WorkspaceViewPaneId, headerRows = 2): WorkspaceViewLayout {
  const constraints = workspaceSurface(id).constraints;
  return {
    weight: constraints.grow,
    minRows: constraints.minHeight,
    headerRows,
    collapsePriority: constraints.collapsePriority ?? 0,
  };
}
