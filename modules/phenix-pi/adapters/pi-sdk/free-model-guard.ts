import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { assessRootMutation } from "../../domain/definition/execution-risk.ts";
import type { SessionProfile } from "../../domain/run/model.ts";

const MUTATION_TOOLS = new Set(["edit", "write", "bash"]);

export function registerFreeModelGuard(
  pi: ExtensionAPI,
  profile: (sessionId: string) => Promise<SessionProfile>,
): void {
  let lastUserInput: string | undefined;

  pi.on("session_start", async () => {
    lastUserInput = undefined;
  });
  pi.on("input", async (event) => {
    if (event.source !== "extension") lastUserInput = event.text;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!MUTATION_TOOLS.has(event.toolName)) return;
    const current = await profile(ctx.sessionManager.getSessionId());
    if (current.modelSet !== "free") return;

    const assessment = assessRootMutation({
      userText: lastUserInput,
      toolName: event.toolName,
      toolInput: event.input,
    });
    if (!assessment.sensitive) return;
    return {
      block: true,
      reason:
        `phenix/free may not perform this sensitive mutation: ${assessment.reasons.join("; ")}. ` +
        `Select phenix/opencode-go, phenix/chatgpt-plus, or phenix/mixed.`,
    };
  });
}
