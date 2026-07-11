import {
  parseCapabilityToken,
  parseContractId,
  parseRunId,
  type ContractIdentity,
} from "./contract.ts";
import {
  isAgentKind,
} from "./policy.ts";

export const PHENIX_CONTRACT_ID_ENV =
  "PHENIX_CONTRACT_ID";

export const PHENIX_CONTRACT_TOKEN_ENV =
  "PHENIX_CONTRACT_TOKEN";

export const PHENIX_RUN_ID_ENV =
  "PHENIX_RUN_ID";

export const PHENIX_AGENT_KIND_ENV =
  "PHENIX_AGENT_KIND";

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

  const capabilityToken =
    parseCapabilityToken(
      env[PHENIX_CONTRACT_TOKEN_ENV],
    );

  if (!capabilityToken) {
    errors.push(
      `${PHENIX_CONTRACT_TOKEN_ENV} is missing or invalid`,
    );
  }

  const role =
    env[PHENIX_AGENT_KIND_ENV];

  if (!role || !isAgentKind(role)) {
    errors.push(
      `${PHENIX_AGENT_KIND_ENV} is missing or invalid`,
    );
  }

  if (
    errors.length > 0 ||
    !contractId ||
    !runId ||
    !capabilityToken ||
    !role ||
    !isAgentKind(role)
  ) {
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
      role,
      capabilityToken,
    },
  };
}
