import { getModels } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelInventory } from "../../ports/model-resolver.ts";

const AUTHLESS_OPENCODE_MODELS = new Set(
  getModels("opencode")
    .filter((model) => model.id.endsWith("-free"))
    .map((model) => model.id),
);

export class PiModelInventory implements ModelInventory {
  private readonly registry: ModelRegistry;

  constructor(registry: ModelRegistry) {
    this.registry = registry;
  }

  available(): readonly { readonly provider: string; readonly model: string }[] {
    const available = this.registry.getAvailable().map((model) => ({
      provider: model.provider,
      model: model.id,
    }));
    const included = new Set(available.map((model) => `${model.provider}/${model.model}`));

    for (const model of AUTHLESS_OPENCODE_MODELS) {
      const key = `opencode/${model}`;
      if (included.has(key) || !this.registry.find("opencode", model)) continue;
      available.push({ provider: "opencode", model });
      included.add(key);
    }

    return available;
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
