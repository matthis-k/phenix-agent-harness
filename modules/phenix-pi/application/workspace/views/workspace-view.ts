import type { ProjectAttention } from "../project-attention.ts";
import type { FileChangeEntry } from "../../file-changes.ts";
import type { ObjectiveTree } from "../../../domain/objective/projection.ts";
import type { RunId } from "../../../domain/shared.ts";
import type { TaskTree } from "../../../domain/task/projection.ts";
import type { WorkspaceSurfaceId } from "../../../domain/workspace/surfaces.ts";
import type { PhenixUiSnapshot } from "../../../extension/phenix-ui.ts";

export const WORKSPACE_VIEW_IDS = ["runs", "objectives", "files", "facts"] as const;
export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];

export interface WorkspaceViewSnapshot {
  readonly ui: PhenixUiSnapshot;
  readonly objectives: ObjectiveTree;
  /** Internal execution telemetry, excluded from user-facing workspace views. */
  readonly localTasks?: TaskTree;
  readonly filesByRun: Readonly<Record<string, readonly FileChangeEntry[]>>;
  readonly attentionByRun: Readonly<Record<string, ProjectAttention>>;
}

export interface WorkspaceViewRow {
  readonly id: string;
  readonly depth: number;
  readonly marker: string;
  readonly state: string;
  readonly stateTone: WorkspaceViewTone;
  readonly label: string;
  readonly detail?: string;
  readonly expanded: boolean;
  readonly expandable: boolean;
  readonly attention?: boolean;
  readonly active?: boolean;
}

export type WorkspaceViewTone = "success" | "error" | "warning" | "muted" | "accent" | "text";

export type WorkspaceViewAction =
  | { readonly kind: "select-run"; readonly runId: RunId }
  | { readonly kind: "inspect-run"; readonly runId: RunId }
  | { readonly kind: "none" };

export interface WorkspaceViewRegistration {
  readonly id: WorkspaceViewId;
  readonly surfaceId: WorkspaceSurfaceId;
  readonly title: string;
  readonly defaultFraction: number;
  readonly minSize: number;
  readonly collapsible: boolean;
  rows(
    snapshot: WorkspaceViewSnapshot,
    input: {
      readonly expandedIds: ReadonlySet<string>;
      readonly activeRunId?: RunId;
    },
  ): readonly WorkspaceViewRow[];
  activate(row: WorkspaceViewRow, snapshot: WorkspaceViewSnapshot): WorkspaceViewAction;
}
