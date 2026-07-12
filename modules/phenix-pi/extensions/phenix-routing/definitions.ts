/**
 * phenix-routing — definitions
 *
 * Declarative routing configuration data.
 *
 * Routing definitions are passive data interpreted by library logic.
 * They must not embed arbitrary runtime callbacks.
 */

import type {
  AgentClientRef,
  CapabilityRef,
} from "../phenix-kernel/refs.ts";
import type {
  Difficulty,
  ThinkingLevel,
} from "../phenix-kernel/task.ts";

// ── Agent difficulty route ─────────────────────────────────────────────────

export interface AgentDifficultyRoute {
  readonly capability: CapabilityRef;
  readonly thinking: ThinkingLevel;
}

// ── Agent route definition ─────────────────────────────────────────────────

export interface AgentRouteDefinition {
  readonly agentClient: AgentClientRef;

  readonly difficulties: Readonly<
    Record<Difficulty, AgentDifficultyRoute>
  >;
}

// ── Model pool ─────────────────────────────────────────────────────────────

export interface ModelPoolDefinition {
  readonly id: string;
  readonly candidates: readonly string[];
}

// ── Model set ──────────────────────────────────────────────────────────────

export interface ModelSetDefinition {
  readonly id: string;

  readonly capabilityPools: Readonly<
    Record<string, string>
  >;

  readonly allowedProviders?: readonly string[];

  readonly guards?: {
    readonly denySecrecy?: readonly string[];
    readonly denyChangeKinds?: readonly string[];
    readonly denyTargetStates?: readonly string[];
  };
}

// ── Routing configuration ──────────────────────────────────────────────────

export interface RoutingConfiguration {
  readonly modelSets: readonly ModelSetDefinition[];

  readonly pools: readonly ModelPoolDefinition[];

  readonly agentRoutes: readonly AgentRouteDefinition[];
}

// ── Model reference ────────────────────────────────────────────────────────

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export function parseModelRef(ref: string): ModelRef {
  const slashIndex = ref.indexOf("/");
  if (
    slashIndex === -1 ||
    slashIndex === 0 ||
    slashIndex === ref.length - 1
  ) {
    throw new Error(
      `Invalid model reference "${ref}": expected "provider/model" format`,
    );
  }
  return {
    provider: ref.slice(0, slashIndex),
    model: ref.slice(slashIndex + 1),
  };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}
