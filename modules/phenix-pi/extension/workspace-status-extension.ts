import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "00-workspace";

interface SelectedModel {
  readonly provider: string;
  readonly id: string;
}

export interface WorkspaceGenericStatusInput {
  readonly model?: SelectedModel;
  readonly thinking: ThinkingLevel;
}

export default function registerWorkspaceStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let model: SelectedModel | undefined;
  let thinking: ThinkingLevel = "off";

  const refresh = (): void => {
    context?.ui.setStatus(
      STATUS_KEY,
      formatWorkspaceGenericStatus({ ...(model ? { model } : {}), thinking }),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    model = selectedModel(ctx);
    thinking = pi.getThinkingLevel();
    refresh();
  });

  pi.on("model_select", (event) => {
    model = { provider: event.model.provider, id: event.model.id };
    thinking = pi.getThinkingLevel();
    refresh();
  });

  pi.on("thinking_level_select", (event) => {
    thinking = event.level;
    refresh();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    model = undefined;
    thinking = "off";
    context = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export function formatWorkspaceGenericStatus(input: WorkspaceGenericStatusInput): string {
  if (input.model?.provider === "phenix") {
    return `phenix/${input.model.id} · budget ${input.thinking}`;
  }
  const model = input.model ? `${input.model.provider}/${input.model.id}` : "model none";
  return `${model} · thinking ${input.thinking}`;
}

function selectedModel(ctx: ExtensionContext): SelectedModel | undefined {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}
