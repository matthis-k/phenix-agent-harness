import { isProviderAllowed, providerBoundaryForSet } from "./config.ts";
import { ROLE_MATRIX } from "./matrix.ts";
import {
  type Capability,
  type Difficulty,
  formatModelRef,
  type ModelRef,
  type ModelSetId,
  parseModelRef,
  type ResolvedRoute,
  type RoutingConfig,
  type RoutingRole,
} from "./types.ts";

const PHENIX_PREFIX = "phenix/";

/** Interface for the model registry used during resolution. */
export interface ModelRegistry {
  /** Return a concrete model when the active registry knows it. */
  getModel?(provider: string, model: string): unknown;
  /** Check if a concrete model exists and is authenticated. */
  isAvailable(provider: string, model: string): boolean | Promise<boolean>;
}

export interface ResolveRouteInput {
  readonly modelSet: ModelSetId;
  readonly role: RoutingRole;
  readonly difficulty: Difficulty;
  readonly modelRegistry: ModelRegistry;
  readonly config: RoutingConfig;
  readonly avoidModels?: readonly ModelRef[];
  readonly taskPolicy?: Record<string, unknown>;
}

/**
 * Resolve a concrete route from the fixed matrix and runtime inventory.
 */
export async function resolveRoute(input: ResolveRouteInput): Promise<ResolvedRoute> {
  const { modelSet, role, modelRegistry, config, avoidModels } = input;

  // 1. Difficulty is workflow-owned and must be resolved before routing.
  const difficulty = input.difficulty;

  // 2. Look up role × difficulty in matrix
  const route = ROLE_MATRIX[role]?.[difficulty];
  if (!route) {
    throw new RoutingError("NO_CANDIDATES", {
      message: `No matrix entry for ${role}/${difficulty}`,
      modelSet,
      role,
      difficulty,
      capability: "general" as Capability,
      pool: "",
      configuredCandidates: [],
    });
  }

  const { capability, thinking } = route;

  // 3. Resolve capability → pool name from model set
  const modelSetDef = config.modelSets[modelSet];
  if (!modelSetDef) {
    throw new RoutingError("NO_CANDIDATES", {
      message: `Unknown model set "${modelSet}"`,
      modelSet,
      role,
      difficulty,
      capability,
      pool: "",
      configuredCandidates: [],
    });
  }

  const poolName = modelSetDef[capability];
  if (!poolName) {
    throw new RoutingError("UNKNOWN_POOL", {
      message: `Model set "${modelSet}" has no mapping for capability "${capability}"`,
      modelSet,
      role,
      difficulty,
      capability,
      pool: "",
      configuredCandidates: [],
    });
  }

  // 4. Read pool candidates
  const candidates = config.pools[poolName];
  if (!candidates || candidates.length === 0) {
    throw new RoutingError("EMPTY_POOL", {
      message: `Pool "${poolName}" is empty or undefined`,
      modelSet,
      role,
      difficulty,
      capability,
      pool: poolName,
      configuredCandidates: [],
    });
  }

  // 5. Parse and validate each candidate
  const allCandidates: ModelRef[] = [];
  const boundaryViolations: string[] = [];
  const malformed: string[] = [];

  const allowedProviders = providerBoundaryForSet(modelSet, config);

  for (const candidate of candidates) {
    // Parse
    let ref: ModelRef;
    try {
      ref = parseModelRef(candidate);
    } catch {
      malformed.push(candidate);
      continue;
    }

    // Reject phenix/*
    if (ref.provider === "phenix" || candidate.startsWith(PHENIX_PREFIX)) {
      continue;
    }

    // Check provider boundary
    if (allowedProviders.length > 0 && !isProviderAllowed(ref.provider, allowedProviders)) {
      boundaryViolations.push(candidate);
      continue;
    }

    allCandidates.push(ref);
  }

  // 6. Check availability
  const missingCandidates: string[] = [];
  const unauthenticatedCandidates: string[] = [];
  const available: Array<{ ref: ModelRef; index: number }> = [];

  for (let i = 0; i < allCandidates.length; i++) {
    const ref = allCandidates[i];
    if (modelRegistry.getModel && !modelRegistry.getModel(ref.provider, ref.model)) {
      missingCandidates.push(formatModelRef(ref));
      continue;
    }

    const available_ = await modelRegistry.isAvailable(ref.provider, ref.model);
    if (available_) {
      available.push({ ref, index: i });
    } else {
      unauthenticatedCandidates.push(formatModelRef(ref));
    }
  }

  // 7. Error if no available candidates
  if (available.length === 0) {
    throw new RoutingError("NO_CANDIDATES", {
      message: `No available candidates for ${modelSet}/${capability} (pool: ${poolName})`,
      modelSet,
      role,
      difficulty,
      capability,
      pool: poolName,
      configuredCandidates: [...candidates],
      missingCandidates: missingCandidates.length > 0 ? missingCandidates : undefined,
      unauthenticatedCandidates:
        unauthenticatedCandidates.length > 0 ? unauthenticatedCandidates : undefined,
      boundaryViolations: boundaryViolations.length > 0 ? boundaryViolations : undefined,
    });
  }

  // 8. Apply avoidModels: prefer a candidate not in avoidModels
  const avoidSet = new Set((avoidModels ?? []).map((ref) => formatModelRef(ref)));

  const preferred = available.find((a) => !avoidSet.has(formatModelRef(a.ref)));

  const chosen = preferred ?? available[0];
  const usedAvoidedModelFallback = preferred === undefined && avoidSet.size > 0;

  return {
    modelSet,
    role,
    difficulty,
    capability,
    pool: poolName,
    candidates: allCandidates,
    model: chosen.ref,
    candidateIndex: chosen.index,
    thinking,
    avoidedModel:
      usedAvoidedModelFallback && avoidSet.size > 0
        ? avoidModels?.find((ref) => formatModelRef(ref) === formatModelRef(chosen.ref))
        : undefined,
    usedAvoidedModelFallback,
  };
}

class RoutingError extends Error {
  readonly code: RoutingErrorCode;
  readonly modelSet: ModelSetId;
  readonly role: RoutingRole;
  readonly difficulty: Difficulty;
  readonly capability: Capability;
  readonly pool: string;
  readonly configuredCandidates: readonly string[];
  readonly missingCandidates?: readonly string[];
  readonly unauthenticatedCandidates?: readonly string[];
  readonly boundaryViolations?: readonly string[];

  constructor(
    code: RoutingErrorCode,
    overrides: {
      message: string;
      modelSet: ModelSetId;
      role: RoutingRole;
      difficulty: Difficulty;
      capability: Capability;
      pool: string;
      configuredCandidates: readonly string[];
      missingCandidates?: readonly string[];
      unauthenticatedCandidates?: readonly string[];
      boundaryViolations?: readonly string[];
    },
  ) {
    super(overrides.message);
    this.name = "RoutingError";
    this.code = code;
    this.modelSet = overrides.modelSet;
    this.role = overrides.role;
    this.difficulty = overrides.difficulty;
    this.capability = overrides.capability;
    this.pool = overrides.pool;
    this.configuredCandidates = overrides.configuredCandidates;
    this.missingCandidates = overrides.missingCandidates;
    this.unauthenticatedCandidates = overrides.unauthenticatedCandidates;
    this.boundaryViolations = overrides.boundaryViolations;
  }
}

type RoutingErrorCode =
  | "NO_CANDIDATES"
  | "BOUNDARY_VIOLATION"
  | "UNKNOWN_POOL"
  | "MALFORMED_REF"
  | "DENIED_ROUTE"
  | "EMPTY_POOL";
