import type { RunId } from "../shared.ts";
import type { EffectId, PaneId } from "./state.ts";

export type WorkspaceErrorCode =
  | "snapshot-load-failed"
  | "transcript-load-failed"
  | "transcript-invalid"
  | "layout-unsatisfied"
  | "view-render-failed"
  | "stale-effect"
  | "invalid-input"
  | "invariant-violation";

export type WorkspaceErrorOwner =
  | { readonly kind: "workspace" }
  | { readonly kind: "pane"; readonly paneId: PaneId }
  | { readonly kind: "run"; readonly runId: RunId }
  | { readonly kind: "effect"; readonly effectId: EffectId };

export interface WorkspaceError {
  readonly code: WorkspaceErrorCode;
  readonly owner: WorkspaceErrorOwner;
  readonly message: string;
  readonly cause?: unknown;
  readonly recoverable: boolean;
}

export function workspaceError(input: WorkspaceError): WorkspaceError {
  return input;
}
