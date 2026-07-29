import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import {
  type NativeInputDelegation,
  resolveNativeInputDelegation,
} from "./workspace-interaction.ts";

export interface NativeWorkspaceHandoffOptions {
  readonly data: string;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly accept?: (delegation: NativeInputDelegation) => boolean;
  readonly handoff: (delegation: NativeInputDelegation) => void;
}

export function handoffNativeWorkspaceInput(
  options: NativeWorkspaceHandoffOptions,
): { readonly data: string } | undefined {
  const delegation = resolveNativeInputDelegation(options.data, options.keybindings);
  if (!delegation || options.accept?.(delegation) === false) return undefined;

  options.handoff(delegation);
  return { data: options.data };
}
