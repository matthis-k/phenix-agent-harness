/**
 * phenix-composition — configuration
 *
 * Top-level Phenix configuration that collects all declarations.
 * This is passive data — no runtime logic or Pi imports.
 */

import type { ContractDefinition } from "../phenix-contracts/definitions.ts";
import type { AgentClientDefinition } from "../phenix-subagents/definitions.ts";
import type { RoutingConfiguration } from "../phenix-routing/definitions.ts";
import type { ModelSetRef } from "../phenix-kernel/refs.ts";

// ── Phenix configuration ───────────────────────────────────────────────────

export interface PhenixConfiguration {
  readonly activeModelSet: ModelSetRef;

  readonly contracts: readonly ContractDefinition[];

  readonly agentClients: readonly AgentClientDefinition[];

  readonly routing: RoutingConfiguration;

  readonly workflows: readonly /** WorkflowDefinition */ unknown[];

  readonly runtime: {
    readonly subagentBackend:
      | "in-process"
      | "pi-subagents-process";

    readonly maximumDelegationDepth: number;
  };
}

// ── Configuration builder ──────────────────────────────────────────────────

export function definePhenixConfiguration(
  configuration: PhenixConfiguration,
): PhenixConfiguration {
  return configuration;
}
