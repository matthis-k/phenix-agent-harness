import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { assessRootMutation } from "../../domain/definition/execution-risk.ts";
import type { ConcreteModelRef } from "../../domain/definition/model.ts";
import type { SessionProfile } from "../../domain/run/model.ts";
import { createVisualizationPublisherExtension } from "./visualization-publisher.ts";

const MUTATION_TOOLS = new Set(["edit", "write", "bash", "nix_shell"]);

export interface FreeModelToolCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly userText?: string;
}

export interface ToolCallBlock {
  readonly block: true;
  readonly reason: string;
}

export function blockSensitiveFreeModelMutation(
  call: FreeModelToolCall,
): ToolCallBlock | undefined {
  if (!MUTATION_TOOLS.has(call.toolName)) return undefined;
  const assessment = assessRootMutation({
    userText: call.userText,
    toolName: call.toolName,
    toolInput: call.toolInput,
  });
  if (!assessment.sensitive) return undefined;
  return {
    block: true,
    reason:
      `phenix/free may not perform this sensitive mutation: ${assessment.reasons.join("; ")}. ` +
      `Select phenix/opencode-go, phenix/chatgpt-plus, or phenix/mixed.`,
  };
}

/**
 * Inline extensions for every managed child session. Visualization publishing
 * is universal; free-tier sessions additionally receive the mutation guard.
 */
export function freeModelSessionExtensions(
  model: ConcreteModelRef | boolean,
): readonly ExtensionFactory[] {
  const guarded = typeof model === "boolean" ? model : isFreeTierModel(model);
  return [
    createVisualizationPublisherExtension(),
    ...(guarded ? [createFreeModelGuardExtension()] : []),
  ];
}

export function isFreeTierModel(model: ConcreteModelRef): boolean {
  return model.provider === "opencode" && model.model.endsWith("-free");
}

// Filesystem extension discovery stays disabled.
// The child backend injects this policy factory explicitly.
export function createFreeModelGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) =>
      blockSensitiveFreeModelMutation({
        toolName: event.toolName,
        toolInput: event.input,
      }),
    );
  };
}

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
    const current = await profile(ctx.sessionManager.getSessionId());
    if (current.modelSet !== "free") return;
    return blockSensitiveFreeModelMutation({
      userText: lastUserInput,
      toolName: event.toolName,
      toolInput: event.input,
    });
  });
}
