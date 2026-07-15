/**
 * subagent-api — caller-facing Phenix subagent vocabulary
 *
 * This module contains only the small API orchestration code should use. It is
 * intentionally independent from workflow records, contract channels, Pi
 * AgentSession, and backend construction details.
 */

import type { Static, TSchema } from "typebox";

import type { JsonSchema } from "../phenix-contracts/definitions.ts";
import type { SubagentSessionOptions } from "./session-options.ts";

/** Structured result expected from a subagent. */
export interface ReturnSpec<TOutput = unknown> {
  readonly schema: JsonSchema;
  readonly name?: string;
  readonly description?: string;
  readonly decode?: (value: unknown) => TOutput;
}

/**
 * Canonical user-facing request for one subagent.
 *
 * Workflow orchestration may fill or constrain `session`, but it should compile
 * this same shape rather than invoke a separate child-session mechanism.
 */
export interface SubagentRequest<TOutput = unknown> {
  readonly task: string;
  readonly returns: ReturnSpec<TOutput>;
  readonly session?: SubagentSessionOptions;
  readonly requirements?: readonly string[];
}

export interface ReturnSpecMetadata {
  readonly name?: string;
  readonly description?: string;
}

export interface ReturnSpecOptions<TOutput> extends ReturnSpecMetadata {
  readonly decode?: (value: unknown) => TOutput;
}

/**
 * Define a TypeBox-backed return contract whose output type is inferred from
 * the schema. Plain JSON Schema values intentionally produce `unknown`.
 */
export function returns<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  options?: ReturnSpecOptions<Static<TSchemaValue>>,
): ReturnSpec<Static<TSchemaValue>>;
export function returns(
  schema: JsonSchema,
  options?: ReturnSpecOptions<unknown>,
): ReturnSpec<unknown>;
export function returns(
  schema: JsonSchema,
  options: ReturnSpecOptions<unknown> = {},
): ReturnSpec<unknown> {
  return {
    schema,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.decode !== undefined ? { decode: options.decode } : {}),
  };
}

/** Define a typed return contract for arbitrary JSON Schema through a decoder. */
export function returnsWithDecoder<TOutput>(
  schema: JsonSchema,
  decode: (value: unknown) => TOutput,
  metadata: ReturnSpecMetadata = {},
): ReturnSpec<TOutput> {
  return {
    schema,
    decode,
    ...(metadata.name !== undefined ? { name: metadata.name } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
  };
}

/** Decode an accepted value using the contract decoder when one is present. */
export function decodeReturnValue<TOutput>(contract: ReturnSpec<TOutput>, value: unknown): TOutput {
  return contract.decode ? contract.decode(value) : (value as TOutput);
}
