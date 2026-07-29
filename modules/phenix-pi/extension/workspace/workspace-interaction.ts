import { matchesKey } from "@earendil-works/pi-tui";

export type WorkspaceInputGroup = "main" | "sidebar";

export type WorkspaceInputIntent =
  | { readonly kind: "editor" }
  | { readonly kind: "copy-selection" }
  | { readonly kind: "native-ui" }
  | { readonly kind: "sidebar-toggle" }
  | { readonly kind: "focus-toggle" }
  | { readonly kind: "focus-main" }
  | { readonly kind: "transcript-page"; readonly direction: 1 | -1 }
  | { readonly kind: "sidebar-section"; readonly direction: 1 | -1 }
  | { readonly kind: "sidebar-item"; readonly direction: 1 | -1 }
  | { readonly kind: "sidebar-edge"; readonly edge: "first" | "last" }
  | { readonly kind: "sidebar-activate" }
  | { readonly kind: "sidebar-collapse" };

export function resolveWorkspaceInput(
  data: string,
  group: WorkspaceInputGroup,
  hasTranscriptSelection = false,
): WorkspaceInputIntent {
  if (data === "\x03" && hasTranscriptSelection) return { kind: "copy-selection" };
  if (data === "\x0f") return { kind: "native-ui" };
  if (data === "\x02") return { kind: "sidebar-toggle" };
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    return { kind: "focus-toggle" };
  }

  if (group === "main") {
    if (matchesKey(data, "pageUp")) return { kind: "transcript-page", direction: -1 };
    if (matchesKey(data, "pageDown")) return { kind: "transcript-page", direction: 1 };
    return { kind: "editor" };
  }

  if (matchesKey(data, "escape")) return { kind: "focus-main" };
  if (data === "h" || matchesKey(data, "left")) {
    return { kind: "sidebar-section", direction: -1 };
  }
  if (data === "l" || matchesKey(data, "right")) {
    return { kind: "sidebar-section", direction: 1 };
  }
  if (data === "k" || matchesKey(data, "up")) {
    return { kind: "sidebar-item", direction: -1 };
  }
  if (data === "j" || matchesKey(data, "down")) {
    return { kind: "sidebar-item", direction: 1 };
  }
  if (matchesKey(data, "home")) return { kind: "sidebar-edge", edge: "first" };
  if (matchesKey(data, "end")) return { kind: "sidebar-edge", edge: "last" };
  if (matchesKey(data, "enter")) return { kind: "sidebar-activate" };
  if (data === " ") return { kind: "sidebar-collapse" };

  return { kind: "editor" };
}

export function nextWorkspaceSection<T>(current: T, direction: 1 | -1, sections: readonly T[]): T {
  if (sections.length === 0) return current;
  const currentIndex = sections.indexOf(current);
  const index = currentIndex < 0 ? 0 : currentIndex;
  return sections[(index + direction + sections.length) % sections.length] ?? current;
}
