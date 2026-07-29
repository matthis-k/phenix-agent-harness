import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

import {
  type NativeInputDelegation,
  resolveNativeInputDelegation,
} from "./workspace-interaction.ts";

export interface NativeWorkspaceHandoffOptions {
  readonly data: string;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly handoff: (delegation: NativeInputDelegation) => "consume" | "forward";
}

export function handoffNativeWorkspaceInput(
  options: NativeWorkspaceHandoffOptions,
): { readonly consume: true } | { readonly data: string } | undefined {
  const delegation = resolveNativeInputDelegation(options.data, options.keybindings);
  if (!delegation) return undefined;

  return options.handoff(delegation) === "consume" ? { consume: true } : { data: options.data };
}
