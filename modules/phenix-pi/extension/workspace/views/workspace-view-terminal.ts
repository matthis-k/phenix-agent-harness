import type { WorkspaceRowPresentation } from "../../../application/workspace/presentation.ts";
import type {
  WorkspaceViewRegistration as SemanticWorkspaceViewRegistration,
  WorkspaceViewRow as SemanticWorkspaceViewRow,
} from "../../../application/workspace/views/workspace-view.ts";
import { color, type ObservabilityTheme } from "../../observability-theme.ts";
import type {
  WorkspaceViewRegistration,
  WorkspaceViewRenderedRow,
  WorkspaceViewRow,
} from "./workspace-view.ts";

export function withTerminalWorkspaceView<TValue>(
  registration: SemanticWorkspaceViewRegistration<TValue>,
): WorkspaceViewRegistration<TValue> {
  return {
    ...registration,
    project: (snapshot, context) =>
      registration.project(snapshot, context).map(withTerminalWorkspaceRenderer),
  };
}

export function withTerminalWorkspaceRenderer<TValue>(
  row: SemanticWorkspaceViewRow<TValue>,
): WorkspaceViewRow<TValue> {
  return {
    ...row,
    render: ({ theme, ...context }) =>
      renderWorkspaceRowForTerminal(row.present(context), theme),
  };
}

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
