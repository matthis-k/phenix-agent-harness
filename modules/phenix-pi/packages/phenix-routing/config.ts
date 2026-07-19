import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import type {
  ModelPoolDefinition,
  ModelSetDefinition,
  RoutingConfiguration,
} from "./definitions.ts";
import { buildRoleMatrixFromDeclarations } from "./matrix.ts";
import type { Capability, ModelSetId, RoutingConfig, RoutingGuard } from "./types.ts";
import { CAPABILITIES, parseModelRef } from "./types.ts";

export interface ConfigDiagnostic {
  readonly message: string;
  readonly severity: "error" | "warning";
}

function declaredModelSetIds(config: RoutingConfig): readonly ModelSetId[] {
  return Object.keys(config.modelSets).map(modelSetId);
}

function isDeclaredModelSet(config: RoutingConfig, value: string): value is ModelSetId {
  return declaredModelSetIds(config).some((modelSet) => modelSet === value);
}

/** Validate a complete routing projection. */
export function validateConfig(config: RoutingConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const declared = declaredModelSetIds(config);

  if (!isDeclaredModelSet(config, config.defaultModelSet)) {
    diagnostics.push({
      message: `defaultModelSet "${config.defaultModelSet}" is not declared; expected one of ${declared.join(", ")}`,
      severity: "error",
    });
  }

  if (config.modelSetOrder.length === 0) {
    diagnostics.push({ message: "modelSetOrder is empty", severity: "error" });
  }

  const seen = new Set<string>();
  for (const setId of config.modelSetOrder) {
    if (!isDeclaredModelSet(config, setId)) {
      diagnostics.push({
        message: `modelSetOrder contains undeclared model set "${setId}"`,
        severity: "error",
      });
    }
    if (seen.has(setId)) {
      diagnostics.push({
        message: `modelSetOrder contains duplicate "${setId}"`,
        severity: "error",
      });
    }
    seen.add(setId);
  }

  for (const [poolName, candidates] of Object.entries(config.pools)) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      diagnostics.push({
        message: `pool "${poolName}" is empty or invalid`,
        severity: "error",
      });
      continue;
    }

    for (const candidate of candidates) {
      if (typeof candidate !== "string") {
        diagnostics.push({
          message: `pool "${poolName}" contains a non-string candidate`,
          severity: "error",
        });
        continue;
      }
      try {
        parseModelRef(candidate);
      } catch {
        diagnostics.push({
          message: `pool "${poolName}" candidate "${candidate}" is malformed`,
          severity: "error",
        });
      }
    }
  }

  for (const setId of declared) {
    const modelSet = config.modelSets[setId];
    if (!modelSet) {
      diagnostics.push({
        message: `modelSet "${setId}" is missing`,
        severity: "error",
      });
      continue;
    }

    for (const capability of CAPABILITIES) {
      const poolName = modelSet[capability];
      if (!poolName) {
        diagnostics.push({
          message: `modelSet "${setId}" is missing capability "${capability}"`,
          severity: "error",
        });
      } else if (!config.pools[poolName]) {
        diagnostics.push({
          message: `modelSet "${setId}" capability "${capability}" references unknown pool "${poolName}"`,
          severity: "error",
        });
      }
    }
  }

  for (const [setId, guard] of Object.entries(config.guards ?? {})) {
    if (!isDeclaredModelSet(config, setId)) {
      diagnostics.push({
        message: `guards reference undeclared model set "${setId}"`,
        severity: "error",
      });
    }
    if (guard.allowedProviders?.length === 0) {
      diagnostics.push({
        message: `modelSet "${setId}" guard has empty allowedProviders`,
        severity: "error",
      });
    }
  }

  return diagnostics;
}

function projectPoolsFromDefinitions(
  pools: readonly ModelPoolDefinition[],
): RoutingConfig["pools"] {
  return Object.fromEntries(pools.map((definition) => [definition.id, [...definition.candidates]]));
}

function projectModelSetsFromDefinitions(
  modelSets: readonly ModelSetDefinition[],
): RoutingConfig["modelSets"] {
  const projected: Record<string, Readonly<Record<Capability, string>>> = {};
  for (const definition of modelSets) {
    projected[definition.id] = definition.capabilityPools as Record<Capability, string>;
  }
  return projected;
}

function projectGuardsFromDefinitions(
  modelSets: readonly ModelSetDefinition[],
): RoutingConfig["guards"] {
  const projected: Record<string, RoutingGuard> = {};
  for (const definition of modelSets) {
    projected[definition.id] = {
      ...(definition.allowedProviders
        ? { allowedProviders: [...definition.allowedProviders] }
        : {}),
      ...(definition.guards?.denySecrecy
        ? { denySecrecy: [...definition.guards.denySecrecy] }
        : {}),
      ...(definition.guards?.denyChangeKinds
        ? { denyChangeKinds: [...definition.guards.denyChangeKinds] }
        : {}),
      ...(definition.guards?.denyTargetStates
        ? { denyTargetStates: [...definition.guards.denyTargetStates] }
        : {}),
    };
  }
  return projected;
}

export function buildRoutingConfigFromDeclarations(input: {
  readonly routing: RoutingConfiguration;
  readonly defaultModelSet: string;
  readonly modelSetOrder?: readonly string[];
}): RoutingConfig {
  return {
    defaultModelSet: modelSetId(input.defaultModelSet),
    modelSetOrder: (
      input.modelSetOrder ?? input.routing.modelSets.map((modelSet) => modelSet.id)
    ).map(modelSetId),
    pools: projectPoolsFromDefinitions(input.routing.pools),
    modelSets: projectModelSetsFromDefinitions(input.routing.modelSets),
    guards: projectGuardsFromDefinitions(input.routing.modelSets),
    roleRoutes: buildRoleMatrixFromDeclarations(input.routing.agentRoutes),
  };
}

let configuredRoutingConfig: RoutingConfig | undefined;

export function configureRoutingConfig(config: RoutingConfig): void {
  const errors = validateConfig(config).filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Invalid routing configuration:\n${errors.map((error) => `  - ${error.message}`).join("\n")}`,
    );
  }
  configuredRoutingConfig = config;
}

export function loadRoutingConfig(): RoutingConfig {
  if (!configuredRoutingConfig) {
    throw new Error(
      "Phenix routing has no configured RoutingConfig. Call configureRoutingConfig from a suite or user extension before registering the provider.",
    );
  }
  return configuredRoutingConfig;
}

export function providerBoundaryForSet(
  modelSet: ModelSetId,
  config: RoutingConfig,
): readonly string[] {
  return config.guards?.[modelSet]?.allowedProviders ?? [];
}

export function isProviderAllowed(provider: string, allowedProviders: readonly string[]): boolean {
  return allowedProviders.includes(provider);
}
