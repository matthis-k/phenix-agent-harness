import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { WorkspaceRuntimeBinding } from "./workspace-runtime-binding.ts";
import { subscribeWorkspaceRuntime } from "./workspace-runtime-binding.ts";

const STATUS_KEY = "phenix";

interface SelectedModel {
  readonly provider: string;
  readonly id: string;
}

export interface WorkspaceGenericStatusInput {
  readonly model?: SelectedModel;
  readonly diagnostics?: DiagnosticSummary;
  readonly integrations?: string;
}

export default function registerWorkspaceStatus(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let model: SelectedModel | undefined;
  let disposeRuntimeStatus: (() => void) | undefined;
  let revision = 0;

  const refresh = (): void => {
    void updateStatus();
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
    revision += 1;
    disposeRuntimeStatus?.();
    disposeRuntimeStatus = undefined;
    binding = undefined;
    model = undefined;
    context = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  async function updateStatus(): Promise<void> {
    const ctx = context;
    const active = binding;
    const currentRevision = ++revision;
    if (!ctx) return;

    let diagnostics: DiagnosticSummary | undefined;
    if (active) {
      try {
        diagnostics = await active.runtime.diagnostics.summary(active.rootRunId);
      } catch {
        diagnostics = undefined;
      }
    }
    if (currentRevision !== revision || ctx !== context || active !== binding) return;

    ctx.ui.setStatus(
      STATUS_KEY,
      formatWorkspaceGenericStatus({
        ...(model ? { model } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ...(active ? { integrations: active.integrations } : {}),
      }),
    );
  }
}

export function formatWorkspaceGenericStatus(input: WorkspaceGenericStatusInput): string {
  const model = input.model ? `${input.model.provider}/${input.model.id}` : "none";
  return `model ${model} · phenix ${healthLabel(input)}`;
}

function healthLabel(input: WorkspaceGenericStatusInput): string {
  if (!input.diagnostics) return "starting";
  const errors = input.diagnostics.counts.error;
  if (errors > 0) return `error (${errors})`;

  const warnings = input.diagnostics.counts.warning;
  const integrationsFailed = input.integrations?.includes("failed:") === true;
  if (warnings > 0 || integrationsFailed) {
    return warnings > 0 ? `degraded (${warnings})` : "degraded";
  }
  return "healthy";
}

function selectedModel(ctx: ExtensionContext): SelectedModel | undefined {
  return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
}
