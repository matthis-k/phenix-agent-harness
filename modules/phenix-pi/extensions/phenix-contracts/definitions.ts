/**
 * phenix-contracts — contract data model
 *
 * Static ContractDefinition values describe reusable handoff schemas. Runtime
 * contract instances reference the same JsonSchema type but carry execution
 * identity, policy, and persistence state in phenix-subagents/contract.ts.
 */

import type { ContractDefinitionId } from "../phenix-kernel/ids.ts";

/** TypeBox-compatible JSON Schema object accepted at contract boundaries. */
export type JsonSchema = Record<string, unknown>;

/** Passive declaration of a reusable structured handoff. */
export interface ContractDefinition<T = unknown> {
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

export interface ContractValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ContractValidationFailure {
  readonly ok: false;
  readonly issues: readonly ContractValidationIssue[];
  readonly summary: string;
}

export type ContractValidationResult<T = unknown> =
  | ContractValidationSuccess<T>
  | ContractValidationFailure;

/** Compiled reusable contract validator. */
export interface CompiledContract<T = unknown> {
  readonly definition: ContractDefinition<T>;
  validate(value: unknown): ContractValidationResult<T>;
}
