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
import type { AgentSessionExecutionBackend } from "../phenix-kernel/index.ts";

// ── Phenix configuration ───────────────────────────────────────────────────

export interface PhenixConfiguration {
  readonly activeModelSet: ModelSetRef;

  readonly contracts: readonly ContractDefinition[];

  readonly agentClients: readonly AgentClientDefinition[];

  readonly routing: RoutingConfiguration;

  readonly workflows: readonly /** WorkflowDefinition */ unknown[];

  readonly runtime: {
    /** How real child agent sessions are executed. A process is one possible backend. */
    readonly sessionExecutionBackend: AgentSessionExecutionBackend;

    readonly maximumDelegationDepth: number;
  };
}

// ── Configuration builder ──────────────────────────────────────────────────

export function definePhenixConfiguration(
  configuration: PhenixConfiguration,
): PhenixConfiguration {
  return configuration;
}
