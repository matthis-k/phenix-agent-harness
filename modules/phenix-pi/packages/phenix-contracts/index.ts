/**
 * phenix-contracts — public contract declaration and validation API.
 *
 * Concrete contract sets belong to suites/user configuration. This package owns
 * the generic declaration and validation mechanics only.
 */

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
