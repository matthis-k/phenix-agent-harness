import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { WorkspaceRuntimeBinding } from "./workspace-runtime-binding.ts";
import { subscribeWorkspaceRuntime } from "./workspace-runtime-binding.ts";

const STATUS_KEY = "phenix";

interface SelectedModel {
  readonly provider: string;
  readonly id: string;
}

export interface WorkspaceGenericStatusInput {
  readonly model?: SelectedModel;
}

export default function registerWorkspaceStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let model: SelectedModel | undefined;
  let disposeRuntimeStatus: (() => void) | undefined;

  const refresh = (): void => {
    if (!context) return;
    context.ui.setStatus(STATUS_KEY, formatWorkspaceGenericStatus({ ...(model ? { model } : {}) }));
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    disposeRuntimeStatus?.();
    disposeRuntimeStatus = undefined;
    binding = next;
    if (next) {
      const subscriptions = [
        next.runtime.events.subscribe(refresh),
        next.runtime.diagnostics.subscribe(refresh),
      ];
      disposeRuntimeStatus = () => {
        for (const unsubscribe of subscriptions) unsubscribe();
      };
    }
    refresh();
  });

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
    disposeRuntimeStatus?.();
    disposeRuntimeStatus = undefined;
    binding = undefined;
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
