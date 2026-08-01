import type { ProjectMap } from "../../domain/project/model.ts";
import type { WorkspaceRunAttention } from "./views/workspace-view.ts";

export function projectWorkspaceAttention(
  projects: readonly ProjectMap[],
): Readonly<Record<string, WorkspaceRunAttention>> {
  const byRun = new Map<string, WorkspaceRunAttention>();
  for (const project of projects) {
    for (const intervention of project.interventions) {
      if (intervention.status !== "pending") continue;
      const runId = String(intervention.requestedBy.runId);
      const current = byRun.get(runId);
      const urgent = intervention.urgency === "urgent";
      byRun.set(runId, {
        kind: "input-required",
        count: (current?.count ?? 0) + 1,
        urgent: current?.urgent === true || urgent,
      });
    }
  }
  return Object.fromEntries(byRun);
}
