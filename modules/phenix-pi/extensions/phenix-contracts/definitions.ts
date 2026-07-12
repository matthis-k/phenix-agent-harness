/**
 * phenix-contracts — static contract definitions
 *
 * A ContractDefinition is a passive declaration of a structured handoff type.
 * It is distinct from a runtime ContractInstance (see ../phenix-subagents/contract.ts).
 */

import type { ContractDefinitionId } from "../phenix-kernel/ids.ts";

// ── JSON Schema (compatible with TypeBox-compatible JSON Schema) ──────────

export type JsonSchema = Record<string, unknown>;

// ── Contract definition ────────────────────────────────────────────────────

export interface ContractDefinition<T = unknown> {
  readonly id: ContractDefinitionId;
  readonly description: string;
  readonly schema: JsonSchema;
}

// ── Validation result ──────────────────────────────────────────────────────

export interface ContractValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

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

// ── Compiled contract ──────────────────────────────────────────────────────

export interface CompiledContract<T = unknown> {
  readonly definition: ContractDefinition<T>;
  validate(value: unknown): ContractValidationResult<T>;
}
