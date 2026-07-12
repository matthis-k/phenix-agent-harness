/**
 * phenix-contracts — public contract declaration and validation API
 *
 * Runtime contract instances remain in phenix-subagents/contract.ts; schema
 * declaration and validation are owned here.
 */

export {
  ARCHITECTURE_HANDOFF,
  BASE_HANDOFF,
  CRITIC_HANDOFF,
  defaultContracts,
  FINALIZER_HANDOFF,
  IMPLEMENTATION_HANDOFF,
  PLANNER_HANDOFF,
  SCOUT_HANDOFF,
  TEST_HANDOFF,
} from "./default-contracts.ts";

export type {
  ContractDefinition,
  ContractValidationFailure,
  ContractValidationIssue,
  ContractValidationResult,
  ContractValidationSuccess,
  JsonSchema,
  SchemaValidation,
  SchemaViolation,
} from "./definitions.ts";

export {
  assertJsonSchema,
  assertOutputSchema,
  validateContract,
  validateSchema,
} from "./validator.ts";
