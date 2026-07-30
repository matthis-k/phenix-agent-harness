import type { RunFact } from "../../../domain/run/observability.ts";
import { factTone, textSpan, type WorkspaceRowPresentation } from "../presentation.ts";
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
    projectWorkspaceFacts(snapshot).map((value) => {
      const present = ({ width }: { readonly width: number }): WorkspaceRowPresentation => ({
        spans: [
          textSpan(compactTime(value.timestamp), { tone: "dim" }),
          textSpan(" "),
          textSpan(truncateWorkspaceText(value.summary, Math.max(8, width - 8)), {
            tone: factTone(value.kind, value.summary),
          }),
        ],
      });
      return {
        id: value.id,
        value,
        activation: { kind: "inspector" as const, view: "facts" as const },
        present,
      };
    }),
});
