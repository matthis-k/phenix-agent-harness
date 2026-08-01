import type {
  ModelCapability,
  ModelResolutionContext,
  ModelSelector,
  PhenixModelSetId,
  PiThinkingLevel,
  ResolvedModel,
  VirtualModelRef,
} from "../../domain/definition/model.ts";
import { virtualModel } from "../../domain/definition/model.ts";
import type { ModelInventory, ModelResolver } from "../../ports/model-resolver.ts";

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
}

export interface CapabilityRoute {
  readonly capability: ModelCapability;
  readonly thinking: PiThinkingLevel;
}

export interface RoutingPolicy {
  route(context: ModelResolutionContext): CapabilityRoute;
  pool(modelSet: PhenixModelSetId, capability: ModelCapability): string | undefined;
  candidates(modelSet: PhenixModelSetId, capability: ModelCapability): readonly ModelCandidate[];
  allows(modelSet: PhenixModelSetId, candidate: ModelCandidate): boolean;
}

/**
 * Stateless routing backend. It interprets injected policy and inventory; it
 * contains no Phenix model pools, role mappings, or provider preferences.
 */
export class PolicyModelResolver implements ModelResolver {
  private readonly inventory: ModelInventory;
  private readonly policy: RoutingPolicy;

  constructor(inventory: ModelInventory, policy: RoutingPolicy) {
    this.inventory = inventory;
    this.policy = policy;
  }

  async resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel> {
    const candidates = await this.resolveCandidates(selector, context);
    const selected = candidates[0];
    if (!selected) throw new Error("No eligible model candidate was resolved");
    return selected;
  }

  async resolveCandidates(
    selector: ModelSelector,
    context: ModelResolutionContext,
  ): Promise<readonly ResolvedModel[]> {
    const route = this.policy.route(context);
    const thinking = context.thinking === "route" ? route.thinking : context.thinking;

    if (selector.kind === "concrete") {
      if (!this.inventory.contains(selector.provider, selector.model)) {
        throw new Error(`Concrete model ${selector.provider}/${selector.model} is unavailable`);
      }
      return [
        {
          requested: selector,
          concrete: selector,
          thinking,
          capability: route.capability,
        },
      ];
    }

    const modelSet = selector.kind === "virtual" ? selector.model : (context.modelSet ?? "mixed");
    const virtual: VirtualModelRef = virtualModel(modelSet);
    const pool = this.policy.pool(modelSet, route.capability);
    const available = new Set(
      this.inventory.available().map((item) => `${item.provider}/${item.model}`),
    );
    const eligible = this.policy
      .candidates(modelSet, route.capability)
      .filter((item) => this.policy.allows(modelSet, item))
      .filter((item) => available.has(`${item.provider}/${item.model}`));

    if (eligible.length === 0) {
      const configured = this.policy
        .candidates(modelSet, route.capability)
        .map((item) => `${item.provider}/${item.model}`)
        .join(", ");
      throw new Error(
        `No authenticated model is available for phenix/${modelSet} capability ${route.capability}. ` +
          `Configured candidates: ${configured || "none"}`,
      );
    }

    return eligible.map((item) => ({
      requested: selector,
      virtual,
      concrete: { kind: "concrete", provider: item.provider, model: item.model },
      thinking,
      capability: route.capability,
      ...(pool ? { pool } : {}),
    }));
  }
}
