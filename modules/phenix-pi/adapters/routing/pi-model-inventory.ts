import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelInventory } from "../../ports/model-resolver.ts";

const AUTHLESS_OPENCODE_MODELS = new Set([
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "north-mini-code-free",
]);

export class PiModelInventory implements ModelInventory {
  private readonly registry: ModelRegistry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  contains(provider: string, model: string): boolean {
    if (
      provider === "opencode" &&
      AUTHLESS_OPENCODE_MODELS.has(model) &&
      this.registry.find(provider, model)
    ) {
      return true;
    }
    return this.registry
      .getAvailable()
      .some((candidate) => candidate.provider === provider && candidate.id === model);
  }
}
