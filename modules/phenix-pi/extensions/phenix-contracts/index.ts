/**
 * phenix-contracts — index
 *
 * Static contract definitions, validation, and registry.
 * Separate from runtime contract instances (phenix-subagents/contract.ts).
 */

// Definitions
export type {
  JsonSchema,
  ContractDefinition,
  ContractValidationIssue,
  ContractValidationSuccess,
  ContractValidationFailure,
  ContractValidationResult,
  CompiledContract,
} from "./definitions.ts";

// Default contracts
export {
  SCOUT_HANDOFF,
  PLANNER_HANDOFF,
  ARCHITECTURE_HANDOFF,
  IMPLEMENTATION_HANDOFF,
  TEST_HANDOFF,
  FINALIZER_HANDOFF,
  CRITIC_HANDOFF,
  BASE_HANDOFF,
  defaultContracts,
} from "./default-contracts.ts";

// Registry
export { ContractRegistry } from "./registry.ts";

// Validator
export { validateContract } from "./validator.ts";
