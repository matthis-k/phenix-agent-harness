import os from "node:os";
import path from "node:path";

import { modelSetId } from "../phenix-kernel/ids.ts";
import { mergeObjects, readJson } from "../phenix-shared.ts";
import { defaultModelPools, defaultModelSets } from "./default-routing.ts";
import type {
  Capability,
  ModelSetId,
  RoutingConfig,
  RoutingGuard,
} from "./types.ts";
import { CAPABILITIES, MODEL_SET_IDS, parseModelRef } from "./types.ts";

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export interface ConfigDiagnostic {
  readonly message: string;
  readonly severity: "error" | "warning";
}

function isBuiltInModelSet(value: string): value is ModelSetId {
  return MODEL_SET_IDS.some((modelSet) => modelSet === value);
}

/** Validate a complete routing projection after user overrides are merged. */
export function validateConfig(config: RoutingConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  if (!isBuiltInModelSet(config.defaultModelSet)) {
    diagnostics.push({
      message: `defaultModelSet "${config.defaultModelSet}" is not declared; expected one of ${MODEL_SET_IDS.join(", ")}`,
      severity: "error",
    });
  }

  if (config.modelSetOrder.length === 0) {
    diagnostics.push({ message: "modelSetOrder is empty", severity: "error" });
  }

  const seen = new Set<string>();
  for (const setId of config.modelSetOrder) {
    if (!isBuiltInModelSet(setId)) {
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

  for (const setId of MODEL_SET_IDS) {
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
    if (!isBuiltInModelSet(setId)) {
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

function projectPools(): RoutingConfig["pools"] {
  return Object.fromEntries(
    defaultModelPools.map((definition) => [definition.id, [...definition.candidates]]),
  );
}

function projectModelSets(): RoutingConfig["modelSets"] {
  const projected: Record<string, Readonly<Record<Capability, string>>> = {};
  for (const definition of defaultModelSets) {
    const capabilities: Partial<Record<Capability, string>> = {};
    for (const capability of CAPABILITIES) {
      const pool = definition.capabilityPools[capability];
      if (!pool) {
        throw new Error(
          `Built-in model set "${definition.id}" is missing capability "${capability}"`,
        );
      }
      capabilities[capability] = pool;
    }
    projected[definition.id] = capabilities as Record<Capability, string>;
  }
  return projected;
}

function projectGuards(): RoutingConfig["guards"] {
  const projected: Record<string, RoutingGuard> = {};
  for (const definition of defaultModelSets) {
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

/**
 * Project the authoritative declarations into the serializable resolver shape.
 *
 * No model, pool, boundary, or guard data is duplicated here.
 */
export function buildBundledConfig(): RoutingConfig {
  return {
    defaultModelSet: modelSetId("mixed"),
    modelSetOrder: [...MODEL_SET_IDS],
    pools: projectPools(),
    modelSets: projectModelSets(),
    guards: projectGuards(),
  };
}

/**
 * Load optional user overrides from `$PI_CODING_AGENT_DIR/phenix-routing.json`.
 *
 * Overrides are data-only patches over the built-in projection. Invalid merged
 * configuration is rejected atomically and the built-in projection is used.
 */
export function loadRoutingConfig(): RoutingConfig {
  const bundled = buildBundledConfig();
  const userPath = path.join(getAgentDir(), "phenix-routing.json");
  const userConfig = readJson(userPath);
  if (!userConfig) return bundled;

  const merged = mergeObjects(
    bundled as unknown as Record<string, unknown>,
    userConfig,
  ) as unknown as RoutingConfig;
  const errors = validateConfig(merged).filter((diagnostic) => diagnostic.severity === "error");

  if (errors.length === 0) return merged;

  console.error(
    "[phenix-routing] Invalid user routing configuration; using built-in declarations:",
  );
  for (const error of errors) {
    console.error(`  ERROR: ${error.message}`);
  }
  return bundled;
}

export function providerBoundaryForSet(
  modelSet: ModelSetId,
  config: RoutingConfig,
): readonly string[] {
  return config.guards?.[modelSet]?.allowedProviders ?? [];
}

export function isProviderAllowed(
  provider: string,
  allowedProviders: readonly string[],
): boolean {
  return allowedProviders.includes(provider);
}
