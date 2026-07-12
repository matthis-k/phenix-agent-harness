/**
 * phenix-composition — linked graph
 *
 * The immutable linked graph produced by the linker.
 * Runtime services consume the linked graph rather than raw configuration.
 */

import type {
  AgentClientId,
  ContractDefinitionId,
  WorkflowDefinitionId,
  ModelSetId,
  CapabilityId,
} from "../phenix-kernel/ids.ts";
import type { Difficulty, ThinkingLevel } from "../phenix-kernel/task.ts";
import type { ContractDefinition } from "../phenix-contracts/definitions.ts";
import type { AgentClientDefinition } from "../phenix-subagents/definitions.ts";

// ── Linked agent client ────────────────────────────────────────────────────

export interface LinkedAgentClient {
  readonly definition: AgentClientDefinition;
  readonly accepts: ReadonlySet<ContractDefinitionId>;
  readonly produces: ReadonlySet<ContractDefinitionId>;
  readonly allowedClients: ReadonlySet<AgentClientId>;
}

// ── Linked routing graph ───────────────────────────────────────────────────

export interface AgentDifficultyRoute {
  readonly capability: CapabilityId;
  readonly thinking: ThinkingLevel;
}

export interface LinkedAgentRoute {
  readonly agentClientId: AgentClientId;
  readonly difficulties: Readonly<Record<Difficulty, AgentDifficultyRoute>>;
}

export interface LinkedModelPool {
  readonly id: string;
  readonly candidates: readonly string[];
}

export interface LinkedModelSet {
  readonly id: ModelSetId;
  readonly capabilityPools: Readonly<Record<CapabilityId, string>>;
  readonly allowedProviders: readonly string[];
  readonly guards?: {
    readonly denySecrecy?: readonly string[];
    readonly denyChangeKinds?: readonly string[];
    readonly denyTargetStates?: readonly string[];
  };
}

export interface LinkedRoutingGraph {
  readonly modelSets: ReadonlyMap<ModelSetId, LinkedModelSet>;
  readonly pools: ReadonlyMap<string, LinkedModelPool>;
  readonly agentRoutes: ReadonlyMap<AgentClientId, LinkedAgentRoute>;
}

// ── Linked workflow definition ─────────────────────────────────────────────

export interface LinkedWorkflowDefinition {
  readonly id: WorkflowDefinitionId;
  readonly version: 1;
  readonly initialState: string;
  /* ... full workflow struct ... */
  readonly raw: unknown;
}

// ── Linked Phenix graph ────────────────────────────────────────────────────

export interface LinkedPhenixGraph {
  readonly activeModelSet: LinkedModelSet;

  readonly contracts: ReadonlyMap<
    ContractDefinitionId,
    ContractDefinition
  >;

  readonly agentClients: ReadonlyMap<
    AgentClientId,
    LinkedAgentClient
  >;

  readonly routing: LinkedRoutingGraph;

  readonly workflows: ReadonlyMap<
    WorkflowDefinitionId,
    LinkedWorkflowDefinition
  >;
}
