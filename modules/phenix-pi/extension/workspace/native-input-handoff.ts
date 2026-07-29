import type { NativeInputDelegation } from "./workspace-interaction.ts";

export interface NativeWorkspaceInputTarget {
  readonly getEditorText: () => string;
  readonly resolveNativeInputDelegation: (data: string) => NativeInputDelegation | undefined;
}

export interface NativeWorkspaceHandoffAction {
  readonly kind: "native";
  readonly text: string;
  readonly reopenWorkspace: boolean;
}

export interface NativeWorkspaceHandoffOptions {
  readonly data: string;
  readonly workspace: NativeWorkspaceInputTarget;
  readonly setNativeEditorText: (text: string) => void;
  readonly closeWorkspace: (action: NativeWorkspaceHandoffAction) => void;
}

export function handoffNativeWorkspaceInput(
  options: NativeWorkspaceHandoffOptions,
): { readonly data: string } | undefined {
  const delegation = options.workspace.resolveNativeInputDelegation(options.data);
  if (!delegation) return undefined;

  const text = options.workspace.getEditorText();
  options.setNativeEditorText(text);
  options.closeWorkspace({
    kind: "native",
    text,
    reopenWorkspace: delegation.reopenWorkspace,
  });
  return { data: options.data };
}
