import type {
  WorkspaceViewRegistration as SemanticWorkspaceViewRegistration,
  WorkspaceViewRow as SemanticWorkspaceViewRow,
  WorkspaceViewContext,
  WorkspaceViewPresentationContext,
  WorkspaceViewSnapshot,
} from "../../../application/workspace/views/workspace-view.ts";
import type { ObservabilityTheme } from "../../observability-theme.ts";

export type {
  WorkspaceViewActivation,
  WorkspaceViewContext,
  WorkspaceViewId,
  WorkspaceViewLayout,
  WorkspaceViewPaneId,
  WorkspaceViewPresentationContext,
  WorkspaceViewSnapshot,
} from "../../../application/workspace/views/workspace-view.ts";
export {
  WORKSPACE_VIEW_IDS,
  workspaceViewLayout,
} from "../../../application/workspace/views/workspace-view.ts";

export interface WorkspaceViewRenderContext extends WorkspaceViewPresentationContext {
  readonly theme: ObservabilityTheme;
}

export interface WorkspaceViewRenderedRow {
  readonly text: string;
  readonly active?: boolean;
  readonly muted?: boolean;
}

export interface WorkspaceViewRow<TValue = unknown> extends SemanticWorkspaceViewRow<TValue> {
  render(context: WorkspaceViewRenderContext): WorkspaceViewRenderedRow;
}

export interface WorkspaceViewRegistration<TValue = unknown>
  extends Omit<SemanticWorkspaceViewRegistration<TValue>, "project"> {
  project(
    snapshot: WorkspaceViewSnapshot,
    context?: WorkspaceViewContext,
  ): readonly WorkspaceViewRow<TValue>[];
}
