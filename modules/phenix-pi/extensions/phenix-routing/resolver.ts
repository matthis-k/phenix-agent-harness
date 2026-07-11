import { ROLE_MATRIX } from "./matrix.ts";
import {
  type Capability,
  type Difficulty,
  type ModelRef,
  type ModelSetId,
  type ResolvedRoute,
  type RoutingConfig,
  type RoutingError,
  type RoutingRole,
  formatModelRef,
  parseModelRef,
} from "./types.ts";
import { difficultyForProfile } from "./classifier.ts";
import { providerBoundaryForSet, isProviderAllowed } from "./config.ts";

const PHENIX_PREFIX = "phenix/";

/** Interface for the model registry used during resolution. */
export interface ModelRegistry {
  /** Check if a concrete model exists and is authenticated. */
  isAvailable(provider: string, model: string): boolean | Promise<boolean>;
}

export interface ResolveRouteInput {
  readonly modelSet: ModelSetId;
  readonly role: RoutingRole;
  readonly difficulty?: Difficulty;
  readonly profile?: {
    readonly complexity: number;
    readonly uncertainty: number;
    readonly consequence: number;
    readonly breadth: number;
    readonly coupling: number;
    readonly novelty: number;
  };
  readonly modelRegistry: ModelRegistry;
  readonly config: RoutingConfig;
  readonly avoidModels?: readonly ModelRef[];
  readonly taskPolicy?: Record<string, unknown>;
}

/**
 * Resolve a concrete route from the fixed matrix and runtime inventory.
 */
export async function resolveRoute(
  input: ResolveRouteInput,
): Promise<ResolvedRoute> {
  const {
    modelSet,
    role,
    modelRegistry,
    config,
    avoidModels,
  } = input;

  // 1. Determine difficulty
  let difficulty: Difficulty;
  if (input.difficulty) {
    difficulty = input.difficulty;
  } else if (input.profile) {
    difficulty = difficultyForProfile(input.profile);
  } else {
    difficulty = "D1";
  }

  // 2. Look up role × difficulty in matrix
  const route = ROLE_MATRIX[role]?.[difficulty];
  if (!route) {
    throw routingError("NO_CANDIDATES", {
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
    throw routingError("NO_CANDIDATES", {
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
    throw routingError("UNKNOWN_POOL", {
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
    throw routingError("EMPTY_POOL", {
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
    const available_ = await modelRegistry.isAvailable(ref.provider, ref.model);
    if (available_) {
      available.push({ ref, index: i });
    } else {
      unauthenticatedCandidates.push(formatModelRef(ref));
    }
  }

  // 7. Error if no available candidates
  if (available.length === 0) {
    throw routingError("NO_CANDIDATES", {
      message: `No available candidates for ${modelSet}/${capability} (pool: ${poolName})`,
      modelSet,
      role,
      difficulty,
      capability,
      pool: poolName,
      configuredCandidates: [...candidates],
      missingCandidates: missingCandidates.length > 0 ? missingCandidates : undefined,
      unauthenticatedCandidates: unauthenticatedCandidates.length > 0 ? unauthenticatedCandidates : undefined,
      boundaryViolations: boundaryViolations.length > 0 ? boundaryViolations : undefined,
    });
  }

  // 8. Apply avoidModels: prefer a candidate not in avoidModels
  const avoidSet = new Set(
    (avoidModels ?? []).map((ref) => formatModelRef(ref)),
  );

  const preferred = available.find(
    (a) => !avoidSet.has(formatModelRef(a.ref)),
  );

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
    avoidedModel: usedAvoidedModelFallback && avoidSet.size > 0
      ? avoidModels?.find((ref) => formatModelRef(ref) === formatModelRef(chosen.ref))
      : undefined,
    usedAvoidedModelFallback,
  };
}

function routingError(
  code: RoutingError["code"],
  overrides: Partial<RoutingError> & {
    message: string;
    modelSet: ModelSetId;
    role: RoutingRole;
    difficulty: Difficulty;
    capability: Capability;
    pool: string;
    configuredCandidates: readonly string[];
  },
): RoutingError {
  return {
    code,
    ...overrides,
  } as RoutingError;
}
