/**
 * phenix-contracts — contract data model
 *
 * Static ContractDefinition values describe reusable handoff schemas. Runtime
 * contract instances reference the same JsonSchema type but carry execution
 * identity, policy, and persistence state in phenix-subagents/contract.ts.
 */

import type { ContractDefinitionId } from "@matthis-k/phenix-kernel/ids.ts";

/** TypeBox-compatible JSON Schema object accepted at contract boundaries. */
export type JsonSchema = Record<string, unknown>;

/** Passive declaration of a reusable structured handoff. */
export interface ContractDefinition {
  readonly id: ContractDefinitionId;
  readonly description: string;
  readonly schema: JsonSchema;
}

/** Canonical schema validation issue used by static contract consumers. */
export interface ContractValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** String-path projection used by model-facing runtime diagnostics. */
export interface SchemaViolation {
  readonly path: string;
  readonly message: string;
}

export type SchemaValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly summary: string;
      readonly violations: readonly SchemaViolation[];
    };

export interface ContractValidationSuccess {
  readonly ok: true;
  readonly value: unknown;
}

export interface ContractValidationFailure {
  readonly ok: false;
  readonly issues: readonly ContractValidationIssue[];
  readonly summary: string;
}

export type ContractValidationResult = ContractValidationSuccess | ContractValidationFailure;
