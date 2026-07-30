import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface NamedCommand {
  readonly name: string;
}

export function workspaceCommandName(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [name] = trimmed.slice(1).split(/\s+/, 1);
  return name || undefined;
}

export function isWorkspaceCommandInput(
  text: string,
  commands: readonly NamedCommand[],
): boolean {
  const name = workspaceCommandName(text);
  return name !== undefined && commands.some((command) => command.name === name);
}

/**
 * Preserve extension-generated message semantics for ordinary workspace input,
 * while submitting registered commands through Pi's native input pipeline.
 */
export function withWorkspaceInputSubmission(pi: ExtensionAPI): ExtensionAPI {
  const sendUserMessage: ExtensionAPI["sendUserMessage"] = (content, options) => {
    if (typeof content === "string" && isWorkspaceCommandInput(content, pi.getCommands())) {
      return pi.submitUserInput(content, options);
    }
    return pi.sendUserMessage(content, options);
  };

  return new Proxy(pi, {
    get(target, property, receiver) {
      return property === "sendUserMessage"
        ? sendUserMessage
        : Reflect.get(target, property, receiver);
    },
  });
}
