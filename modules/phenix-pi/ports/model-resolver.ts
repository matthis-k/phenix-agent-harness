import type {
  ModelCapability,
  ModelResolutionContext,
  ModelSelector,
  PhenixModelSetId,
  PiThinkingLevel,
  ResolvedModel,
} from "../domain/definition/model.ts";

export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
}

export interface ModelRoute {
  readonly capability: ModelCapability;
  readonly thinking: PiThinkingLevel;
}

export interface RoutingPolicy {
  readonly revision: string;
  route(context: ModelResolutionContext): ModelRoute;
  candidates(modelSet: PhenixModelSetId, capability: ModelCapability): readonly ModelCandidate[];
  allows(modelSet: PhenixModelSetId, candidate: ModelCandidate): boolean;
}

export interface ModelResolver {
  resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel>;
}

export interface ModelInventory {
  available(): readonly ModelCandidate[];
  contains(provider: string, model: string): boolean;
}
