import {
  parseCapabilityToken,
  parseContractId,
  parseRunId,
  type ContractId,
  type ContractIdentity,
  type RunId,
} from "./contract.ts";

// ── Environment variable names ──────────────────────────────────────────────

export const PHENIX_CONTRACT_ID_ENV = "PHENIX_CONTRACT_ID";
export const PHENIX_CONTRACT_TOKEN_ENV = "PHENIX_CONTRACT_TOKEN";
export const PHENIX_RUN_ID_ENV = "PHENIX_RUN_ID";
export const PHENIX_CONTRACT_STORE_ENV = "PHENIX_CONTRACT_STORE";

// ── Bootstrap environment result types ──────────────────────────────────────

export interface RootBootstrapEnvironment {
  readonly kind: "root";
}

export interface ChildBootstrapEnvironment {
  readonly kind: "child";
  readonly identity: ContractIdentity;
  readonly storeRoot: string;
}

export type BootstrapEnvironmentResult =
  | RootBootstrapEnvironment
  | ChildBootstrapEnvironment;

// ── Decoders ────────────────────────────────────────────────────────────────

/**
 * Decode the contract identity from environment variables.
 * Returns the decoded identity or validation errors.
 */
export type DecodedContractIdentity =
  | {
      readonly ok: true;
      readonly identity: ContractIdentity;
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
    };

export function decodeContractIdentity(
  env: NodeJS.ProcessEnv = process.env,
): DecodedContractIdentity {
  const errors: string[] = [];

  const contractId = parseContractId(
    env[PHENIX_CONTRACT_ID_ENV],
  );

  if (!contractId) {
    errors.push(
      `${PHENIX_CONTRACT_ID_ENV} is missing or invalid`,
    );
  }

  const runId = parseRunId(
    env[PHENIX_RUN_ID_ENV],
  );

  if (!runId) {
    errors.push(
      `${PHENIX_RUN_ID_ENV} is missing or invalid`,
    );
  }

  const capabilityToken = parseCapabilityToken(
    env[PHENIX_CONTRACT_TOKEN_ENV],
  );

  if (!capabilityToken) {
    errors.push(
      `${PHENIX_CONTRACT_TOKEN_ENV} is missing or invalid`,
    );
  }

  if (errors.length > 0 || !contractId || !runId || !capabilityToken) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    identity: {
      contractId,
      runId,
      capabilityToken,
    },
  };
}

/**
 * Decode the complete child bootstrap environment.
 *
 * Returns:
 * - { kind: "root" } when no PHENIX_CONTRACT_ID is present (root process).
 * - { kind: "child", ... } when all required environment values are present and valid.
 *
 * A partially populated contract environment is fatal. The only valid states are:
 * - no PHENIX_CONTRACT_ID → root process
 * - all required contract environment values valid → child process
 */
export function decodeContractBootstrapEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapEnvironmentResult {
  // If no contract ID is set, this is a root process.
  if (!env[PHENIX_CONTRACT_ID_ENV]) {
    return { kind: "root" };
  }

  // Contract ID is present — all required values must be valid.
  const decoded = decodeContractIdentity(env);

  if (!decoded.ok) {
    throw new Error(
      `Phenix child bootstrap failed: ${decoded.errors.join(", ")}. ` +
      `A child process must have all required contract environment values.`,
    );
  }

  const storeRoot = env[PHENIX_CONTRACT_STORE_ENV];
  if (!storeRoot || typeof storeRoot !== "string" || storeRoot.length === 0) {
    throw new Error(
      `Phenix child bootstrap failed: ${PHENIX_CONTRACT_STORE_ENV} is missing or invalid. ` +
      `A child process must have a contract-store root.`,
    );
  }

  return {
    kind: "child",
    identity: decoded.identity,
    storeRoot,
  };
}

// Legacy exports for existing callers (will be cleaned up in Phase 9).
export type { ContractIdentity, ContractId, RunId };
