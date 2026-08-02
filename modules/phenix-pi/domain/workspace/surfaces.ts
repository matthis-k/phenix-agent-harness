import type { PaneId } from "./state.ts";

export const WORKSPACE_SURFACE_IDS = [
  "transcript",
  "editor",
  "runs",
  "objectives",
  "files",
  "facts",
] as const satisfies readonly PaneId[];

export type WorkspaceSurfaceId = (typeof WORKSPACE_SURFACE_IDS)[number];
export type WorkspaceSurfaceRole = "document" | "input" | "collection";
export type WorkspaceSurfaceOverflow = "scroll" | "clip" | "collapse";

export interface WorkspaceSurfaceConstraints {
  readonly minWidth: number;
  readonly minHeight: number;
  readonly grow: number;
  readonly shrink: number;
  readonly overflow: WorkspaceSurfaceOverflow;
  readonly collapsePriority?: number;
}

export interface WorkspaceSurfaceDefinition {
  readonly id: WorkspaceSurfaceId;
  readonly role: WorkspaceSurfaceRole;
  readonly focusable: boolean;
  readonly constraints: WorkspaceSurfaceConstraints;
}

export const WORKSPACE_SURFACES = [
  defineSurface("transcript", "document", {
    minWidth: 32,
    minHeight: 5,
    grow: 4,
    shrink: 1,
    overflow: "scroll",
  }),
  defineSurface("editor", "input", {
    minWidth: 32,
    minHeight: 1,
    grow: 0,
    shrink: 0,
    overflow: "clip",
  }),
  defineSurface("runs", "collection", {
    minWidth: 24,
    minHeight: 2,
    grow: 5,
    shrink: 1,
    overflow: "collapse",
    collapsePriority: 0,
  }),
  defineSurface("objectives", "collection", {
    minWidth: 24,
    minHeight: 2,
    grow: 2,
    shrink: 1,
    overflow: "collapse",
    collapsePriority: 20,
  }),
  defineSurface("files", "collection", {
    minWidth: 24,
    minHeight: 2,
    grow: 3,
    shrink: 1,
    overflow: "collapse",
    collapsePriority: 30,
  }),
  defineSurface("facts", "collection", {
    minWidth: 24,
    minHeight: 2,
    grow: 3,
    shrink: 1,
    overflow: "collapse",
    collapsePriority: 40,
  }),
] as const satisfies readonly WorkspaceSurfaceDefinition[];

const SURFACES_BY_ID = new Map(WORKSPACE_SURFACES.map((surface) => [surface.id, surface]));

export function workspaceSurface(id: WorkspaceSurfaceId): WorkspaceSurfaceDefinition {
  const surface = SURFACES_BY_ID.get(id);
  if (!surface) throw new Error(`Workspace surface ${id} is not registered`);
  return surface;
}

function defineSurface(
  id: WorkspaceSurfaceId,
  role: WorkspaceSurfaceRole,
  constraints: WorkspaceSurfaceConstraints,
): WorkspaceSurfaceDefinition {
  return { id, role, focusable: true, constraints };
}
