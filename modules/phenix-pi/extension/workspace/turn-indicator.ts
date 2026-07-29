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
  if (!state.rootActive) {
    const background =
      activeDescendants > 0
        ? ` ${color(theme, "dim", "·")} ${color(
            theme,
            "muted",
            `${activeDescendants} agent${activeDescendants === 1 ? "" : "s"} background`,
          )}`
        : "";
    return `${heading(theme, "TURN")} ${color(theme, "dim", "·")} ${strong(
      theme,
      "YOU",
    )}${background}`;
  }

  const owner = activeDescendants > 0 ? "PHENIX + AGENTS" : "PHENIX";
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
