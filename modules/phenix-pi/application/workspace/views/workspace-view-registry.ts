import { factsWorkspaceView } from "./facts-view.ts";
import { filesWorkspaceView } from "./files-view.ts";
import { objectivesWorkspaceView } from "./objectives-view.ts";
import { runsWorkspaceView } from "./runs-view.ts";
import {
  WORKSPACE_VIEW_IDS,
  type WorkspaceViewId,
  type WorkspaceViewRegistration,
} from "./workspace-view.ts";

export interface WorkspaceViewRegistry {
  readonly ordered: readonly WorkspaceViewRegistration[];
  get(id: WorkspaceViewId): WorkspaceViewRegistration;
}

export function createWorkspaceViewRegistry(
  registrations: readonly WorkspaceViewRegistration[],
): WorkspaceViewRegistry {
  const byId = new Map<WorkspaceViewId, WorkspaceViewRegistration>();
  for (const registration of registrations) {
    if (byId.has(registration.id)) {
      throw new Error(`Workspace view ${registration.id} is registered more than once`);
    }
    byId.set(registration.id, registration);
  }

  const missing = WORKSPACE_VIEW_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Workspace view registry is missing: ${missing.join(", ")}`);
  }

  const ordered = [...registrations];
  return {
    ordered,
    get: (id) => {
      const registration = byId.get(id);
      if (!registration) throw new Error(`Workspace view ${id} is not registered`);
      return registration;
    },
  };
}

export const workspaceViewRegistry = createWorkspaceViewRegistry([
  runsWorkspaceView,
  objectivesWorkspaceView,
  filesWorkspaceView,
  factsWorkspaceView,
]);
