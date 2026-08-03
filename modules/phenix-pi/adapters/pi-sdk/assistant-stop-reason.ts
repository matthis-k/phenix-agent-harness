import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { AgentSessionBackendFailureObservation } from "../../ports/agent-session-backend.ts";

export function assistantFailureObservation(
  message: AgentMessage,
): AgentSessionBackendFailureObservation | undefined {
  if (message.role !== "assistant") return undefined;

  switch (message.stopReason) {
    case "error":
      return {
        type: "backend.failed",
        kind: "provider_error",
        stopReason: "error",
        message: message.errorMessage ?? "Pi provider failed",
        retryable: true,
        providerMessage: message.errorMessage ?? null,
      };
    case "aborted":
      return {
        type: "backend.failed",
        kind: "unexpected_abort",
        stopReason: "aborted",
        message: "Pi assistant turn ended with stopReason=aborted",
        retryable: true,
      };
    case "stop":
    case "length":
    case "toolUse":
      return undefined;
    default:
      return assertNever(message.stopReason);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Pi assistant stop reason: ${String(value)}`);
}
