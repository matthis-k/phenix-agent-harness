import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { AgentSessionObservation } from "../../ports/agent-session-backend.ts";

type BackendFailureObservation = Extract<
  AgentSessionObservation,
  { readonly type: "backend.failed" }
>;

export function assistantFailureObservation(
  message: AgentMessage,
): BackendFailureObservation | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  return {
    type: "backend.failed",
    message:
      message.errorMessage ??
      (message.stopReason === "aborted"
        ? "Pi assistant turn ended with stopReason=aborted"
        : "Pi provider failed"),
    retryable: true,
  };
}
