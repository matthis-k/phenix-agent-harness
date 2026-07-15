/**
 * subagent-api — caller-facing Phenix subagent vocabulary
 *
 * This module contains only the small API orchestration code should use. It is
 * intentionally independent from workflow records, contract channels, Pi
 * AgentSession, and backend construction details.
 */

import type { JsonSchema } from "../phenix-contracts/definitions.ts";
import type { SubagentSessionOptions } from "./session-options.ts";

/** Typed structured result expected from a subagent. */
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

export interface ReturnSpecOptions<TOutput> {
  readonly name?: string;
  readonly description?: string;
  readonly decode?: (value: unknown) => TOutput;
}

/** Define a reusable typed return contract for `SubagentRequest`. */
export function returns<TOutput = unknown>(
  schema: JsonSchema,
  options: ReturnSpecOptions<TOutput> = {},
): ReturnSpec<TOutput> {
  return {
    schema,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.decode !== undefined ? { decode: options.decode } : {}),
  };
}
