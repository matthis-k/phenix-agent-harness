import type { AgentKind } from "../phenix-kernel/agents.ts";
import type { ModelSetId } from "../phenix-kernel/ids.ts";
import { modelSetId } from "../phenix-kernel/ids.ts";
import type { Difficulty, TaskProfile, ThinkingLevel } from "../phenix-kernel/task.ts";
import { defaultModelSets } from "./default-routing.ts";

// ── Re-export canonical types from kernel ──────────────────────────────────

export type { Difficulty, ModelSetId, TaskProfile, ThinkingLevel };

// ── Built-in model sets ────────────────────────────────────────────────────

/**
 * Built-in model-set identifiers projected from the authoritative declarations.
 *
 * User configuration may override the contents of a built-in model set, but it
 * cannot silently introduce a model set that has no linked provider model.
 */
export const MODEL_SET_IDS: readonly ModelSetId[] = defaultModelSets.map((definition) =>
  modelSetId(definition.id),
);

// ── Capability (routing-owned concept) ─────────────────────────────────────

export const CAPABILITIES = [
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

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITIES.includes(value as Capability);
}

export function capabilityFromId(value: string): Capability {
  if (!isCapability(value)) {
    throw new Error(`Unknown routing capability "${value}"`);
  }
  return value;
}

// ── Routing role ───────────────────────────────────────────────────────────

export const ROUTING_ROLES = [
  "coordinator",
  "base",
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "critic",
  "finalizer",
] as const;

export type RoutingRole = "coordinator" | "base" | AgentKind;

export function isRoutingRole(value: unknown): value is RoutingRole {
  return typeof value === "string" && ROUTING_ROLES.includes(value as RoutingRole);
}

export function routingRoleFromId(value: string): RoutingRole {
  if (!isRoutingRole(value)) {
    throw new Error(`Unknown routing role "${value}"`);
  }
  return value;
}

// ── Route and model types ──────────────────────────────────────────────────

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

export interface RoutingGuard {
  readonly allowedProviders?: readonly string[];
  readonly denySecrecy?: readonly string[];
  readonly denyChangeKinds?: readonly string[];
  readonly denyTargetStates?: readonly string[];
}

/**
 * Runtime projection consumed by the resolver and user-override loader.
 *
 * The bundled value is generated from `default-routing.ts`; this interface is
 * intentionally a serializable data shape, not another declaration authority.
 */
export interface RoutingConfig {
  readonly defaultModelSet: ModelSetId;
  readonly modelSetOrder: readonly ModelSetId[];
  readonly pools: Readonly<Record<string, readonly string[]>>;
  readonly modelSets: Readonly<Record<string, Readonly<Record<Capability, string>>>>;
  readonly guards?: Readonly<Record<string, RoutingGuard>>;
}

export interface RoutingError {
  readonly code:
    | "NO_CANDIDATES"
    | "BOUNDARY_VIOLATION"
    | "UNKNOWN_POOL"
    | "MALFORMED_REF"
    | "DENIED_ROUTE"
    | "EMPTY_POOL";
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

/** Parse a `provider/model` string into a model reference. */
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

/** Format a model reference as `provider/model`. */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}
