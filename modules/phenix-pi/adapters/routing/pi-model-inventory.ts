import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { ModelTarget } from "../../domain/definition/model.ts";
import type { ModelInventory } from "../../ports/model-resolver.ts";

const PI_BACKEND = "pi";
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

  available(): readonly ModelTarget[] {
    const available = this.registry.getAvailable().map((model) => ({
      backend: PI_BACKEND,
      provider: model.provider,
      model: model.id,
    }));
    const included = new Set(
      available.map((model) => `${model.backend}/${model.provider}/${model.model}`),
    );

    for (const model of AUTHLESS_OPENCODE_MODELS) {
      const key = `${PI_BACKEND}/opencode/${model}`;
      if (included.has(key) || !this.registry.find("opencode", model)) continue;
      available.push({ backend: PI_BACKEND, provider: "opencode", model });
      included.add(key);
    }

    return available;
  }

  contains(target: ModelTarget): boolean {
    if (target.backend !== PI_BACKEND) return false;
    if (
      target.provider === "opencode" &&
      AUTHLESS_OPENCODE_MODELS.has(target.model) &&
      this.registry.find(target.provider, target.model)
    ) {
      return true;
    }
    return this.registry
      .getAvailable()
      .some(
        (candidate) =>
          candidate.provider === target.provider && candidate.id === target.model,
      );
  }
}
