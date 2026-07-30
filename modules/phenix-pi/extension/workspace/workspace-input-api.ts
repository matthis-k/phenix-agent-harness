import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Preserve extension-generated message semantics for ordinary workspace input,
 * while submitting slash-prefixed user input through Pi's native input pipeline.
 */
export function withWorkspaceInputSubmission(pi: ExtensionAPI): ExtensionAPI {
  const sendUserMessage: ExtensionAPI["sendUserMessage"] = (content, options) => {
    if (typeof content === "string" && content.startsWith("/")) {
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
