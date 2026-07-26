import type { AgentPromptMode } from "../../domain/definition/definition.ts";

export interface PiPromptResourceOptions {
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: string[];
  readonly systemPromptOverride?: (base: string | undefined) => string | undefined;
}

export function composeManagedPrompt(
  mode: AgentPromptMode | undefined,
  prompt: string,
): PiPromptResourceOptions {
  if (mode !== "append-default") return { systemPrompt: prompt };
  return {
    systemPromptOverride: () => undefined,
    appendSystemPrompt: [prompt],
  };
}
