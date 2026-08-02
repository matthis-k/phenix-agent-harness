import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export const WORKSPACE_NATIVE_HANDOFF = "\x1b]phenix-native\x07";
export const WORKSPACE_COPY_TRANSCRIPT = "\x1b]phenix-copy-transcript\x07";

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

export interface NativeInputDelegation {
  readonly action: AppKeybinding;
  readonly reopenWorkspace: boolean;
}

const NATIVE_HANDOFF_ACTIONS = [
  "app.interrupt",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.followUp",
  "app.message.dequeue",
  "app.clipboard.pasteImage",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
] as const satisfies readonly AppKeybinding[];

const NATIVE_MODAL_ACTIONS = new Set<AppKeybinding>([
  "app.exit",
  "app.model.select",
  "app.session.new",
  "app.session.tree",
  "app.session.fork",
  "app.session.resume",
]);

export function resolveNativeInputDelegation(
  data: string,
  keybindings: Pick<KeybindingsManager, "matches">,
): NativeInputDelegation | undefined {
  for (const action of NATIVE_HANDOFF_ACTIONS) {
    if (!keybindings.matches(data, action)) continue;
    return {
      action,
      reopenWorkspace: !NATIVE_MODAL_ACTIONS.has(action),
    };
  }
  return undefined;
}

export function resolveWorkspaceInput(
  data: string,
  group: WorkspaceInputGroup,
  _hasTranscriptSelection = false,
): WorkspaceInputIntent {
  if (data === WORKSPACE_NATIVE_HANDOFF) return { kind: "native-ui" };
  if (data === WORKSPACE_COPY_TRANSCRIPT || matchesKey(data, "ctrl+shift+c")) {
    return { kind: "copy-selection" };
  }
  if (matchesKey(data, "tab")) return { kind: "focus-toggle" };

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
