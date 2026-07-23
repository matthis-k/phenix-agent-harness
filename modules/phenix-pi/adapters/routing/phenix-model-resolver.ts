import type {
  ModelResolutionContext,
  ModelSelector,
  PiThinkingLevel,
  ResolvedModel,
  VirtualModelRef,
} from "../../domain/definition/model.ts";
import type { ModelInventory, ModelResolver } from "../../ports/model-resolver.ts";

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
}

export interface RoutingPolicy {
  readonly revision: string;
  select(
    selector: VirtualModelRef,
    context: ModelResolutionContext,
    available: readonly ModelCandidate[],
  ): ModelCandidate | undefined;
  thinking(context: ModelResolutionContext): PiThinkingLevel;
}

export const deterministicMixedPolicy: RoutingPolicy = {
  revision: "phenix-mixed-v1",
  select(selector, context, available) {
    if (available.length === 0) return undefined;
    const key = `${selector.model}:${context.definitionId}:${context.parentDefinitionId}`;
    return available[stableHash(key) % available.length];
  },
  thinking(context) {
    const role = roleFromDefinition(context.definitionId);
    const routed: Readonly<Record<string, PiThinkingLevel>> = {
      scout: "low",
      planner: "high",
      implementer: "medium",
      verifier: "high",
      critic: "high",
      base: "medium",
    };
    return routed[role] ?? "medium";
  },
};

export class PhenixModelResolver implements ModelResolver {
  private readonly inventory: ModelInventory;
  private readonly policy: RoutingPolicy;

  constructor(inventory: ModelInventory, policy: RoutingPolicy = deterministicMixedPolicy) {
    this.inventory = inventory;
    this.policy = policy;
  }

  async resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel> {
    const thinking =
      context.thinking === "route" ? this.policy.thinking(context) : context.thinking;
    if (selector.kind === "concrete") {
      if (!this.inventory.contains(selector.provider, selector.model)) {
        throw new Error(`Concrete model ${selector.provider}/${selector.model} is unavailable`);
      }
      return {
        requested: selector,
        concrete: selector,
        thinking,
        policyRevision: this.policy.revision,
      };
    }
    if (selector.provider !== "phenix") throw new Error(`Unsupported virtual provider`);

    const available = this.inventory
      .available()
      .filter((model) => model.provider !== "phenix")
      .sort((left, right) =>
        `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
      );
    const candidate = this.policy.select(selector, context, available);
    if (!candidate || !available.some((item) => sameModel(item, candidate))) {
      throw new Error(`No authenticated concrete model is available for ${selector.model}`);
    }

    return {
      requested: selector,
      concrete: { kind: "concrete", provider: candidate.provider, model: candidate.model },
      thinking,
      policyRevision: this.policy.revision,
    };
  }
}

function roleFromDefinition(definition: string): string {
  const tail = definition.split(".").at(-1) ?? "base";
  if (tail.includes("synthesizer")) return "base";
  return tail;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function sameModel(left: ModelCandidate, right: ModelCandidate): boolean {
  return left.provider === right.provider && left.model === right.model;
}
