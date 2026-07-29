import type { RunFact } from "../../../domain/run/observability.ts";
import { defineWorkspaceView, type WorkspaceViewSnapshot } from "./workspace-view.ts";
import { compactTime, truncateWorkspaceText } from "./workspace-view-format.ts";

const RECENT_FACT_LIMIT = 50;

export function projectWorkspaceFacts(snapshot: WorkspaceViewSnapshot): readonly RunFact[] {
  return [...snapshot.ui.facts].reverse().slice(0, RECENT_FACT_LIMIT);
}

export const factsWorkspaceView = defineWorkspaceView<RunFact>({
  id: "facts",
  title: "Facts",
  layout: {
    weight: 3,
    minRows: 2,
    headerRows: 2,
    collapsePriority: 40,
  },
  project: (snapshot) =>
    projectWorkspaceFacts(snapshot).map((value) => ({
      id: value.id,
      value,
      activation: { kind: "inspector", view: "facts" },
      render: ({ width }) => ({
        muted: true,
        text: `${compactTime(value.timestamp)} ${truncateWorkspaceText(value.summary, Math.max(8, width - 8))}`,
      }),
    })),
});
