import type { WorkspaceSourceListener } from "../application/workspace/frontend.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunId } from "../domain/shared.ts";

export const WORKSPACE_RUNTIME_EVENT = "phenix:workspace-runtime";

export interface WorkspaceRuntimeBinding {
  readonly runtime: PhenixRuntime;
  readonly rootRunId: RunId;
  readonly integrations: string;
}

export interface WorkspaceRuntimeEventBus {
  readonly on: (event: string, listener: (value: unknown) => void) => unknown;
  readonly emit: (event: string, value: unknown) => unknown;
}

type Listener = (binding: WorkspaceRuntimeBinding | undefined) => void;

type WorkspaceRuntimeEvent =
  | { readonly kind: "ready"; readonly binding: WorkspaceRuntimeBinding }
  | { readonly kind: "cleared"; readonly rootRunId: RunId };

export function publishWorkspaceRuntime(
  events: WorkspaceRuntimeEventBus,
  binding: WorkspaceRuntimeBinding,
): void {
  events.emit(WORKSPACE_RUNTIME_EVENT, {
    kind: "ready",
    binding,
  } satisfies WorkspaceRuntimeEvent);
}

export function clearWorkspaceRuntime(events: WorkspaceRuntimeEventBus, rootRunId: RunId): void {
  events.emit(WORKSPACE_RUNTIME_EVENT, {
    kind: "cleared",
    rootRunId,
  } satisfies WorkspaceRuntimeEvent);
}

export function subscribeWorkspaceRuntime(
  events: WorkspaceRuntimeEventBus,
  listener: Listener,
): void {
  let currentRootRunId: RunId | undefined;
  events.on(WORKSPACE_RUNTIME_EVENT, (value) => {
    const event = parseWorkspaceRuntimeEvent(value);
    if (!event) return;
    if (event.kind === "ready") {
      currentRootRunId = event.binding.rootRunId;
      listener(event.binding);
      return;
    }
    if (currentRootRunId && event.rootRunId !== currentRootRunId) return;
    currentRootRunId = undefined;
    listener(undefined);
  });
}

/** Subscribe a workspace view to the runtime projections that can change it. */
export function subscribeWorkspaceChanges(
  runtime: PhenixRuntime,
  listener: WorkspaceSourceListener,
): () => void {
  const notifySnapshot = (): void => listener({ kind: "snapshot" });
  const subscriptions = [
    runtime.events.subscribe(notifySnapshot),
    runtime.diagnostics.subscribe(notifySnapshot),
    runtime.transcripts.subscribe((runId) => listener({ kind: "transcript", runId })),
    runtime.projects.subscribe(notifySnapshot),
    runtime.userForms.subscribe(notifySnapshot),
  ];
  return () => {
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}

function parseWorkspaceRuntimeEvent(value: unknown): WorkspaceRuntimeEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "ready" && isWorkspaceRuntimeBinding(value.binding)) {
    return { kind: "ready", binding: value.binding };
  }
  if (value.kind === "cleared" && typeof value.rootRunId === "string") {
    return { kind: "cleared", rootRunId: value.rootRunId as RunId };
  }
  return undefined;
}

function isWorkspaceRuntimeBinding(value: unknown): value is WorkspaceRuntimeBinding {
  return (
    isRecord(value) &&
    isRecord(value.runtime) &&
    typeof value.rootRunId === "string" &&
    typeof value.integrations === "string"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
