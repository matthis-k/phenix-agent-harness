import type { WorkspaceRowPresentation } from "../../../application/workspace/presentation.ts";
import { color, type ObservabilityTheme } from "../../observability-theme.ts";
import type { WorkspaceViewRenderedRow } from "./workspace-view.ts";

export function renderWorkspaceRowForTerminal(
  presentation: WorkspaceRowPresentation,
  theme: ObservabilityTheme,
): WorkspaceViewRenderedRow {
  return {
    text: presentation.spans
      .map((span) => {
        const emphasized = span.strong ? theme.bold(span.text) : span.text;
        const tone = span.tone ?? (span.strong ? "text" : undefined);
        return tone ? color(theme, tone, emphasized) : emphasized;
      })
      .join(""),
    ...(presentation.active === undefined ? {} : { active: presentation.active }),
    ...(presentation.muted === undefined ? {} : { muted: presentation.muted }),
  };
}
