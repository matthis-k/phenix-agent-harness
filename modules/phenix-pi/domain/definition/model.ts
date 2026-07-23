export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ConcreteModelRef = {
  readonly kind: "concrete";
  readonly provider: string;
  readonly model: string;
};

export type VirtualModelRef = {
  readonly kind: "virtual";
  readonly provider: "phenix";
  readonly model: string;
};

export type ModelSelector = ConcreteModelRef | VirtualModelRef;
export type ThinkingPolicy = PiThinkingLevel | "route";

export interface ModelResolutionContext {
  readonly definitionId: string;
  readonly parentDefinitionId: string;
  readonly thinking: ThinkingPolicy;
}

export interface ResolvedModel {
  readonly requested: ModelSelector;
  readonly concrete: ConcreteModelRef;
  readonly thinking: PiThinkingLevel;
  readonly policyRevision: string;
}
