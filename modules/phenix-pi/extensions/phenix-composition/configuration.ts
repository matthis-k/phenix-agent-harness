/**
 * phenix-composition — configuration
 *
 * Top-level Phenix configuration collects passive declarations and runtime
 * policy. Runtime mechanisms are selected by the composition root and are not
 * represented as user-selectable data until multiple implementations are
 * actually supported.
 *
 * Workflow authority is intentionally absent here. Phenix currently ships one
 * built-in deterministic workflow, defined and validated by phenix-workflow.
 * Adding configurable workflows requires a real typed definition and linker;
 * an untyped placeholder would only create a false source of truth.
 */

import type { ContractDefinition } from "../phenix-contracts/definitions.ts";
import type { ModelSetRef } from "../phenix-kernel/refs.ts";
import type { RoutingConfiguration } from "../phenix-routing/definitions.ts";
import type { AgentClientDefinition } from "../phenix-subagents/definitions.ts";

export interface PhenixConfiguration {
  /** Model set selected for the root virtual provider. */
  readonly activeModelSet: ModelSetRef;

  /** Reusable structured handoff declarations. */
  readonly contracts: readonly ContractDefinition[];

  /** Passive agent-client declarations linked before runtime startup. */
  readonly agentClients: readonly AgentClientDefinition[];

  /** Passive routing declarations projected into runtime lookup structures. */
  readonly routing: RoutingConfiguration;

  /** Runtime policy shared by workflow authority and child-session execution. */
  readonly runtime: {
    readonly maximumDelegationDepth: number;
    readonly persistChildSessions: boolean;
  };
}

export function definePhenixConfiguration(configuration: PhenixConfiguration): PhenixConfiguration {
  return configuration;
}
