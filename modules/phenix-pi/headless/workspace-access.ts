import type { WorkspaceRuntimeBinding } from "../extension/workspace-runtime-binding.ts";
import type { PiHeadlessWorkspaceAccess } from "./pi-executor.ts";

export class ObservableWorkspaceAccess implements PiHeadlessWorkspaceAccess {
  readonly #listeners = new Set<() => void>();
  #binding: WorkspaceRuntimeBinding | undefined;

  current(): WorkspaceRuntimeBinding | undefined {
    return this.#binding;
  }

  replace(binding: WorkspaceRuntimeBinding | undefined): void {
    if (this.#binding === binding) return;
    this.#binding = binding;
    for (const listener of this.#listeners) listener();
  }

  changed(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
