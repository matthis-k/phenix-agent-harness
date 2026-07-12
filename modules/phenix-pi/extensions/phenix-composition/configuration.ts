/**
 * phenix-composition — configuration
 *
 * Top-level Phenix configuration that collects passive declarations and
 * runtime policy. Runtime mechanisms are selected by the composition root and
 * are not represented as user-selectable data until multiple implementations
 * are actually supported.
 */

import type { ContractDefinition } from "../phenix-contracts/definitions.ts";
import type { ModelSetRef } from "../phenix-kernel/refs.ts";
import type { RoutingConfiguration } from "../phenix-routing/definitions.ts";
import type { AgentClientDefinition } from "../phenix-subagents/definitions.ts";

export interface PhenixConfiguration {
  readonly activeModelSet: ModelSetRef;

  readonly contracts: readonly ContractDefinition[];

  readonly agentClients: readonly AgentClientDefinition[];

  readonly routing: RoutingConfiguration;

  readonly workflows: readonly /** WorkflowDefinition */ unknown[];

  readonly runtime: {
    readonly maximumDelegationDepth: number;

    readonly persistChildSessions: boolean;
  };
}

export function definePhenixConfiguration(
  configuration: PhenixConfiguration,
): PhenixConfiguration {
  return configuration;
}
