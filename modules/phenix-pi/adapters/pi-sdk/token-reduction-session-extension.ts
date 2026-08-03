import {
  isToolCallEventType,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type { TokenReductionService } from "../../application/token-reduction-service.ts";

export function createTokenReductionSessionExtension(
  reduction: TokenReductionService,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      if (!isToolCallEventType("bash", event)) return;
      const command = event.input.command;
      if (typeof command !== "string") return;
      const preparation = await reduction.prepareBash(event.toolCallId, command);
      if (preparation.kind === "rewrite") event.input.command = preparation.command;
    });

    pi.on("tool_result", async (event) => {
      if (event.toolName !== "bash") return;
      const result = await reduction.complete({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input,
        content: event.content,
        details: event.details,
        isError: event.isError,
      });
      if (!result) return;
      return {
        content: result.content as typeof event.content,
        details: result.details,
      };
    });

    pi.on("session_shutdown", async () => reduction.shutdown());
  };
}
