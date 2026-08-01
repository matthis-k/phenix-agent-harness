import type { ModelInventory } from "../../ports/model-resolver.ts";
import {
  PolicyModelResolver,
  type CapabilityRoute,
  type ModelCandidate,
  type RoutingPolicy,
} from "../../framework/routing/policy-model-resolver.ts";
import {
  defaultRoutingPolicy,
  MODEL_SETS,
} from "../../suite/phenix-routing-policy.ts";

export type { CapabilityRoute, ModelCandidate, RoutingPolicy };
export { defaultRoutingPolicy, MODEL_SETS };

/** Concrete Phenix facade over the reusable policy-driven routing backend. */
export class PhenixModelResolver extends PolicyModelResolver {
  constructor(inventory: ModelInventory, policy: RoutingPolicy = defaultRoutingPolicy) {
    super(inventory, policy);
  }
}
