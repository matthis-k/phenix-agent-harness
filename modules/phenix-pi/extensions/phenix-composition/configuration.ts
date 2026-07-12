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

// ── Child session backend kind ──────────────────────────────────────────────

export type ChildSessionBackendKind = "sdk" | "rpc";

// ── Phenix configuration ───────────────────────────────────────────────────

export interface PhenixConfiguration {
  readonly activeModelSet: ModelSetRef;

  readonly contracts: readonly ContractDefinition[];

  readonly agentClients: readonly AgentClientDefinition[];

  readonly routing: RoutingConfiguration;

  readonly workflows: readonly /** WorkflowDefinition */ unknown[];

  readonly runtime: {
    /** How real child agent sessions are backed. */
    readonly childSessionBackend: ChildSessionBackendKind;

    readonly maximumDelegationDepth: number;

    readonly persistChildSessions: boolean;

    /** RPC-specific settings — validated only when RPC is selected. */
    readonly rpc?: {
      readonly cliPath?: string;
      readonly sessionDirectory?: string;
      readonly childExtensionPath?: string;
    };
  };
}

// ── Configuration builder ──────────────────────────────────────────────────

export function definePhenixConfiguration(
  configuration: PhenixConfiguration,
): PhenixConfiguration {
  return configuration;
}
