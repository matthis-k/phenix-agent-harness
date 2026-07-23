import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelInventory } from "../../ports/model-resolver.ts";

export class PiModelInventory implements ModelInventory {
  private readonly registry: ModelRegistry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  available(): readonly { readonly provider: string; readonly model: string }[] {
    return this.registry.getAvailable().map((model) => ({
      provider: model.provider,
      model: model.id,
    }));
  }

  contains(provider: string, model: string): boolean {
    return this.registry
      .getAvailable()
      .some((candidate) => candidate.provider === provider && candidate.id === model);
  }
}
