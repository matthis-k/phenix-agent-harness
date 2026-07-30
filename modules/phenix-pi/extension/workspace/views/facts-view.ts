import type { RunFact } from "../../../domain/run/observability.ts";
import { color, fact } from "../../observability-theme.ts";
import {
  defineWorkspaceView,
  type WorkspaceViewSnapshot,
  workspaceViewLayout,
} from "./workspace-view.ts";
import { compactTime, truncateWorkspaceText } from "./workspace-view-format.ts";

const RECENT_FACT_LIMIT = 50;

export function projectWorkspaceFacts(snapshot: WorkspaceViewSnapshot): readonly RunFact[] {
  return [...snapshot.ui.facts].reverse().slice(0, RECENT_FACT_LIMIT);
}

export const factsWorkspaceView = defineWorkspaceView<RunFact>({
  id: "facts",
  title: "Facts",
  layout: workspaceViewLayout("facts"),
  project: (snapshot) =>
    projectWorkspaceFacts(snapshot).map((value) => ({
      id: value.id,
      value,
      activation: { kind: "inspector", view: "facts" },
      render: ({ theme, width }) => ({
        text: `${color(theme, "dim", compactTime(value.timestamp))} ${fact(
          theme,
          value.kind,
          value.summary,
          truncateWorkspaceText(value.summary, Math.max(8, width - 8)),
        )}`,
      }),
    })),
});
