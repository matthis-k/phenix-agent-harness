import type { BudgetMode, EffortLevel } from "./effort.ts";

export type PiThinkingLevel = EffortLevel;

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

export const DIFFICULTIES = ["D0", "D1", "D2", "D3"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Backend-local model identity. It is only valid after backend dispatch. */
export type ConcreteModelRef = {
  readonly kind: "concrete";
  readonly provider: string;
  readonly model: string;
};

/** Globally routable model identity. */
export type ModelTarget = {
  readonly backend: string;
  readonly provider: string;
  readonly model: string;
};

/** Explicit fully-qualified selector for a concrete model target. */
export type TargetModelRef = ModelTarget & {
  readonly kind: "target";
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

export type ModelSelector =
  | ConcreteModelRef
  | TargetModelRef
  | VirtualModelRef
  | SessionModelRef;
export type ThinkingPolicy = PiThinkingLevel | "route";

export interface DifficultyModelRoute {
  readonly model: ModelSelector;
  readonly capability: ModelCapability;
  readonly thinking: PiThinkingLevel;
}

export type DifficultyModelRoutes = Readonly<Record<Difficulty, DifficultyModelRoute>>;

export interface ModelResolutionContext {
  readonly definitionId: string;
  readonly parentDefinitionId: string;
  readonly thinking: ThinkingPolicy;
  readonly modelSet?: PhenixModelSetId;
  readonly difficulty?: Difficulty;
  readonly budget?: BudgetMode;
  readonly capability?: ModelCapability;
}

export interface ResolvedModel {
  readonly requested: ModelSelector;
  readonly virtual?: VirtualModelRef;
  readonly target: ModelTarget;
  readonly concrete: ConcreteModelRef;
  readonly thinking: PiThinkingLevel;
  readonly capability?: ModelCapability;
  readonly pool?: string;
}

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

export function isPhenixModelSet(value: string): value is PhenixModelSetId {
  return (PHENIX_MODEL_SETS as readonly string[]).includes(value);
}

export function modelTarget(backend: string, provider: string, model: string): ModelTarget {
  const normalizedBackend = modelTargetSegment("backend", backend);
  const normalizedProvider = modelTargetSegment("provider", provider);
  const normalizedModel = model.trim();
  if (!normalizedModel) throw new Error("Model target model must not be empty");
  return {
    backend: normalizedBackend,
    provider: normalizedProvider,
    model: normalizedModel,
  };
}

export function targetModel(backend: string, provider: string, model: string): TargetModelRef {
  return { kind: "target", ...modelTarget(backend, provider, model) };
}

export function formatModelTarget(target: ModelTarget): string {
  return `${target.backend}/${target.provider}/${target.model}`;
}

export function parseModelTarget(value: string): ModelTarget {
  const firstSeparator = value.indexOf("/");
  const secondSeparator = value.indexOf("/", firstSeparator + 1);
  if (
    firstSeparator <= 0 ||
    secondSeparator <= firstSeparator + 1 ||
    secondSeparator >= value.length - 1
  ) {
    throw new Error(
      `Invalid model target '${value}'; expected backend/provider/model`,
    );
  }
  return modelTarget(
    value.slice(0, firstSeparator),
    value.slice(firstSeparator + 1, secondSeparator),
    value.slice(secondSeparator + 1),
  );
}

export function virtualModel(model: PhenixModelSetId): VirtualModelRef {
  return { kind: "virtual", provider: "phenix", model };
}

function modelTargetSegment(name: "backend" | "provider", value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Model target ${name} must not be empty`);
  if (normalized.includes("/")) {
    throw new Error(`Model target ${name} must not contain '/'`);
  }
  return normalized;
}
