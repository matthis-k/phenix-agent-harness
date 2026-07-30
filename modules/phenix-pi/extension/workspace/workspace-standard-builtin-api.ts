import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isStandardBuiltinCommand,
  runWorkspaceBuiltin,
  standardBuiltinCommandInfo,
} from "./workspace-standard-builtins.ts";

export type WorkspaceBuiltinExecutor = (commandText: string) => Promise<void>;

/**
 * Present Pi built-ins to the Phenix workspace without registering duplicate
 * extension commands. Submitted built-ins stay on the Phenix renderer path.
 */
export function withWorkspaceStandardBuiltins(
  pi: ExtensionAPI,
  execute: WorkspaceBuiltinExecutor = (commandText) =>
    pi.runCommandAction((ctx) => runWorkspaceBuiltin(pi, ctx, commandText)),
): ExtensionAPI {
  const builtins = standardBuiltinCommandInfo();
  const builtinNames = new Set(builtins.map((command) => command.name));
  const getCommands = (() => [
    ...builtins,
    ...pi.getCommands().filter((command) => !builtinNames.has(command.name)),
  ]) as ExtensionAPI["getCommands"];
  const sendUserMessage = ((content, options) => {
    if (typeof content === "string" && isStandardBuiltinCommand(content)) {
      return execute(content);
    }
    return pi.sendUserMessage(content, options);
  }) as ExtensionAPI["sendUserMessage"];

  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "getCommands") return getCommands;
      if (property === "sendUserMessage") return sendUserMessage;
      return Reflect.get(target, property, receiver);
    },
  });
}
