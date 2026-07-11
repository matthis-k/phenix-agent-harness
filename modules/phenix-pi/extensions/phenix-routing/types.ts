import type { AgentKind } from "../phenix-subagents/policy.ts";

export const MODEL_SET_IDS = [
  "free",
  "opencode-go",
  "gpt",
  "mixed",
] as const;

export type ModelSetId = (typeof MODEL_SET_IDS)[number];

export type Difficulty = "D0" | "D1" | "D2" | "D3";

export type RoutingRole =
  | "coordinator"
  | AgentKind;

export type Capability =
  | "fast"
  | "general"
  | "reasoning"
  | "reasoning-max"
  | "code-fast"
  | "code"
  | "code-max"
  | "review"
  | "review-max";

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

export interface RoleRoute {
  readonly capability: Capability;
  readonly thinking: ThinkingLevel;
}

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface ResolvedRoute {
  readonly modelSet: ModelSetId;
  readonly role: RoutingRole;
  readonly difficulty: Difficulty;
  readonly capability: Capability;
  readonly pool: string;
  readonly candidates: readonly ModelRef[];
  readonly model: ModelRef;
  readonly candidateIndex: number;
  readonly thinking: ThinkingLevel;
  readonly avoidedModel?: ModelRef;
  readonly usedAvoidedModelFallback: boolean;
}

export interface PhenixRoutingSettings {
  readonly version: 1;
  readonly modelSet: ModelSetId;
}

export interface RoutingConfig {
  readonly defaultModelSet: ModelSetId;
  readonly modelSetOrder: readonly ModelSetId[];

  readonly pools: Readonly<Record<string, readonly string[]>>;

  readonly modelSets: Readonly<
    Record<ModelSetId, Readonly<Record<Capability, string>>>
  >;

  readonly guards?: Partial<
    Record<ModelSetId, {
      readonly allowedProviders?: readonly string[];
      readonly denySecrecy?: readonly string[];
      readonly denyChangeKinds?: readonly string[];
      readonly denyTargetStates?: readonly string[];
    }>
  >;
}

export interface TaskProfile {
  readonly complexity: number;
  readonly uncertainty: number;
  readonly consequence: number;
  readonly breadth: number;
  readonly coupling: number;
  readonly novelty: number;
}

export interface RoutingError {
  readonly code: "NO_CANDIDATES" | "BOUNDARY_VIOLATION" | "UNKNOWN_POOL" | "MALFORMED_REF" | "DENIED_ROUTE" | "EMPTY_POOL";
  readonly message: string;
  readonly modelSet: ModelSetId;
  readonly role: RoutingRole;
  readonly difficulty: Difficulty;
  readonly capability: Capability;
  readonly pool: string;
  readonly configuredCandidates: readonly string[];
  readonly missingCandidates?: readonly string[];
  readonly unauthenticatedCandidates?: readonly string[];
  readonly boundaryViolations?: readonly string[];
}

/** Parse a "provider/model" string into a ModelRef */
export function parseModelRef(ref: string): ModelRef {
  const slashIndex = ref.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0 || slashIndex === ref.length - 1) {
    throw new Error(`Invalid model reference "${ref}": expected "provider/model" format`);
  }
  return {
    provider: ref.slice(0, slashIndex),
    model: ref.slice(slashIndex + 1),
  };
}

/** Format a ModelRef back to "provider/model" */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}
