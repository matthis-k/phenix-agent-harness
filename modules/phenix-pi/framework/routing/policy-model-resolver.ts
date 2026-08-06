import type {
  ModelCapability,
  ModelResolutionContext,
  ModelSelector,
  ModelTarget,
  PhenixModelSetId,
  PiThinkingLevel,
  ResolvedModel,
  VirtualModelRef,
} from "../../domain/definition/model.ts";
import { formatModelTarget, virtualModel } from "../../domain/definition/model.ts";
import type { ModelInventory, ModelResolver } from "../../ports/model-resolver.ts";

export type ModelCandidate = ModelTarget;

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

    if (selector.kind === "target") {
      if (!this.inventory.contains(selector)) {
        throw new Error(`Model target ${formatModelTarget(selector)} is unavailable`);
      }
      return [resolvedTarget(selector, selector, thinking, route.capability)];
    }

    if (selector.kind === "concrete") {
      const matches = this.inventory
        .available()
        .filter(
          (target) => target.provider === selector.provider && target.model === selector.model,
        );
      if (matches.length === 0) {
        throw new Error(`Concrete model ${selector.provider}/${selector.model} is unavailable`);
      }
      if (matches.length > 1) {
        throw new Error(
          `Concrete model ${selector.provider}/${selector.model} exists in multiple backends: ` +
            `${matches.map(formatModelTarget).join(", ")}. Use a backend-qualified target.`,
        );
      }
      const target = matches[0];
      if (!target) throw new Error("Concrete model resolution lost its only target");
      return [resolvedTarget(selector, target, thinking, route.capability)];
    }

    const modelSet = selector.kind === "virtual" ? selector.model : (context.modelSet ?? "mixed");
    const virtual: VirtualModelRef = virtualModel(modelSet);
    const pool = this.policy.pool(modelSet, route.capability);
    const available = new Set(this.inventory.available().map(formatModelTarget));
    const eligible = this.policy
      .candidates(modelSet, route.capability)
      .filter((item) => this.policy.allows(modelSet, item))
      .filter((item) => available.has(formatModelTarget(item)));

    if (eligible.length === 0) {
      const configured = this.policy
        .candidates(modelSet, route.capability)
        .map(formatModelTarget)
        .join(", ");
      throw new Error(
        `No authenticated model is available for phenix/${modelSet} capability ${route.capability}. ` +
          `Configured candidates: ${configured || "none"}`,
      );
    }

    return eligible.map((target) => ({
      requested: selector,
      virtual,
      target,
      concrete: {
        kind: "concrete",
        provider: target.provider,
        model: target.model,
      },
      thinking,
      capability: route.capability,
      ...(pool ? { pool } : {}),
    }));
  }
}

function resolvedTarget(
  requested: ModelSelector,
  target: ModelTarget,
  thinking: PiThinkingLevel,
  capability: ModelCapability,
): ResolvedModel {
  return {
    requested,
    target: {
      backend: target.backend,
      provider: target.provider,
      model: target.model,
    },
    concrete: {
      kind: "concrete",
      provider: target.provider,
      model: target.model,
    },
    thinking,
    capability,
  };
}
