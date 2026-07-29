import { color, heading, type ObservabilityTheme, strong } from "../observability-theme.ts";

export interface WorkspaceTurnState {
  readonly rootActive: boolean;
  readonly activeDescendants: number;
}

export function renderWorkspaceTurn(
  theme: ObservabilityTheme | undefined,
  state: WorkspaceTurnState,
): string {
  const activeDescendants = Math.max(0, state.activeDescendants);
  if (!state.rootActive && activeDescendants === 0) {
    return `${heading(theme, "TURN")} ${color(theme, "dim", "·")} ${strong(theme, "YOU")}`;
  }

  const owner = state.rootActive
    ? activeDescendants > 0
      ? "PHENIX + AGENTS"
      : "PHENIX"
    : "AGENTS";
  const count =
    activeDescendants > 0
      ? ` ${color(theme, "dim", "·")} ${color(theme, "warning", `${activeDescendants} active`)}`
      : "";
  return `${heading(theme, "TURN")} ${color(theme, "dim", "·")} ${color(
    theme,
    "warning",
    owner,
  )}${count} ${color(theme, "dim", "· input steers")}`;
}
