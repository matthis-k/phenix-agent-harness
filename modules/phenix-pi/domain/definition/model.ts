export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PHENIX_MODEL_SETS = ["free", "opencode-go", "chatgpt-plus", "mixed"] as const;
export type PhenixModelSetId = (typeof PHENIX_MODEL_SETS)[number];

export const MODEL_CAPABILITIES = [
  "fast",
  "general",
  "reasoning",
  "reasoning-max",
  "code-fast",
  "code",
  "code-max",
  "review",
  "review-max",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export type Difficulty = "D0" | "D1" | "D2" | "D3";

export type ConcreteModelRef = {
  readonly kind: "concrete";
  readonly provider: string;
  readonly model: string;
};

export type VirtualModelRef = {
  readonly kind: "virtual";
  readonly provider: "phenix";
  readonly model: PhenixModelSetId;
};

/** Resolve through the model set selected for the owning session. */
export type SessionModelRef = {
  readonly kind: "session";
};

export type ModelSelector = ConcreteModelRef | VirtualModelRef | SessionModelRef;
export type ThinkingPolicy = PiThinkingLevel | "route";

export interface ModelResolutionContext {
  readonly definitionId: string;
  readonly parentDefinitionId: string;
  readonly thinking: ThinkingPolicy;
  readonly modelSet?: PhenixModelSetId;
  readonly difficulty?: Difficulty;
}

export interface ResolvedModel {
  readonly requested: ModelSelector;
  readonly virtual?: VirtualModelRef;
  readonly concrete: ConcreteModelRef;
  readonly thinking: PiThinkingLevel;
  readonly capability?: ModelCapability;
  readonly pool?: string;
  readonly policyRevision: string;
}

export function isPhenixModelSet(value: string): value is PhenixModelSetId {
  return (PHENIX_MODEL_SETS as readonly string[]).includes(value);
}

export function virtualModel(model: PhenixModelSetId): VirtualModelRef {
  return { kind: "virtual", provider: "phenix", model };
}
