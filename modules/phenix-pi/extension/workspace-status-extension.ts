import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "00-workspace";

interface SelectedModel {
  readonly provider: string;
  readonly id: string;
}

export interface WorkspaceGenericStatusInput {
  readonly model?: SelectedModel;
}

export default function registerWorkspaceStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let model: SelectedModel | undefined;

  const refresh = (): void => {
    context?.ui.setStatus(STATUS_KEY, formatWorkspaceGenericStatus(model ? { model } : {}));
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    model = selectedModel(ctx);
    refresh();
  });

  pi.on("model_select", (event) => {
    model = { provider: event.model.provider, id: event.model.id };
    refresh();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    model = undefined;
    context = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export function formatWorkspaceGenericStatus(input: WorkspaceGenericStatusInput): string {
  const model = input.model ? `${input.model.provider}/${input.model.id}` : "none";
  return `model ${model}`;
}

function selectedModel(ctx: ExtensionContext): SelectedModel | undefined {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}
