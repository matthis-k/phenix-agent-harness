import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunId } from "../domain/shared.ts";

export interface WorkspaceRuntimeBinding {
  readonly runtime: PhenixRuntime;
  readonly rootRunId: RunId;
  readonly integrations: string;
}

type Listener = (binding: WorkspaceRuntimeBinding | undefined) => void;

let current: WorkspaceRuntimeBinding | undefined;
const listeners = new Set<Listener>();

export function currentWorkspaceRuntime(): WorkspaceRuntimeBinding | undefined {
  return current;
}

export function publishWorkspaceRuntime(binding: WorkspaceRuntimeBinding): void {
  current = binding;
  for (const listener of listeners) listener(binding);
}

export function clearWorkspaceRuntime(rootRunId?: RunId): void {
  if (rootRunId && current?.rootRunId !== rootRunId) return;
  current = undefined;
  for (const listener of listeners) listener(undefined);
}

export function subscribeWorkspaceRuntime(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}
