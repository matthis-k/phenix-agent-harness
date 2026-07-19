/**
 * Phenix routing registry — bridges to Pi's active model registry.
 *
 * Owned by the routing extension. Separated from index.ts to avoid
 * circular imports with stream-proxy.ts.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRegistry as PiModelRegistry,
} from "@earendil-works/pi-coding-agent";

export class PhenixUpstreamRuntime {
  private registry?: PiModelRegistry;

  bind(ctx: ExtensionContext): void {
    this.registry = ctx.modelRegistry;
  }

  requireRegistry(): PiModelRegistry {
    if (!this.registry) {
      throw new Error("Phenix upstream registry is not initialized");
    }
    return this.registry;
  }

  getModel(provider: string, model: string): Model<Api> | undefined {
    return this.requireRegistry().find(provider, model);
  }

  async isAvailable(provider: string, model: string): Promise<boolean> {
    const concreteModel = this.getModel(provider, model);
    if (!concreteModel) return false;
    const auth = await this.requireRegistry().getApiKeyAndHeaders(concreteModel);
    return auth.ok;
  }

  getApiKeyAndHeaders(
    concreteModel: Model<Api>,
  ): ReturnType<PiModelRegistry["getApiKeyAndHeaders"]> {
    return this.requireRegistry().getApiKeyAndHeaders(concreteModel);
  }
}

export const modelRegistry = new PhenixUpstreamRuntime();
