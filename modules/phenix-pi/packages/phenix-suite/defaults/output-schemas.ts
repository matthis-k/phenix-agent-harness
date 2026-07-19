import type { ContractDefinition } from "@matthis-k/phenix-contracts/definitions.ts";
import { registerOutputSchemas } from "@matthis-k/phenix-flow/workflow-schemas.ts";
import { defaultContracts } from "./contracts.ts";

export function outputSchemasFromContracts(
  contracts: readonly ContractDefinition[] = defaultContracts,
): Readonly<Record<string, Record<string, unknown>>> {
  return Object.fromEntries(contracts.map((contract) => [contract.id, contract.schema]));
}

export const defaultOutputSchemas = outputSchemasFromContracts(defaultContracts);

registerOutputSchemas(defaultOutputSchemas);
