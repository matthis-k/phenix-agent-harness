/**
 * phenix-composition — linked graph
 *
 * Immutable declarations produced by the linker. Runtime services consume this
 * graph instead of raw configuration so references are validated once at the
 * composition boundary.
 */

import type { ContractDefinition } from "@matthis-k/phenix-contracts/definitions.ts";
import type {
  AgentClientId,
  CapabilityId,
  ContractDefinitionId,
  ModelSetId,
} from "@matthis-k/phenix-kernel/ids.ts";
import type { Difficulty, ThinkingLevel } from "@matthis-k/phenix-kernel/task.ts";
import type { AgentClientDefinition } from "../subagents/definitions.ts";

/** Agent declaration with all symbolic contract and delegation references resolved. */
export interface LinkedAgentClient {
  readonly definition: AgentClientDefinition;
  readonly accepts: ReadonlySet<ContractDefinitionId>;
  readonly produces: ReadonlySet<ContractDefinitionId>;
  readonly allowedClients: ReadonlySet<AgentClientId>;
}

/** Route selected for one difficulty tier. */
export interface AgentDifficultyRoute {
  readonly capability: CapabilityId;
  readonly thinking: ThinkingLevel;
}

/** Runtime lookup projection for one agent client. */
export interface LinkedAgentRoute {
  readonly agentClientId: AgentClientId;
  readonly difficulties: Readonly<Record<Difficulty, AgentDifficultyRoute>>;
}

/** Named ordered candidate pool. */
export interface LinkedModelPool {
  readonly id: string;
  readonly candidates: readonly string[];
}

/** Linked model-set declaration with capability and provider policy. */
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

/** Routing declarations indexed for deterministic runtime lookup. */
export interface LinkedRoutingGraph {
  readonly modelSets: ReadonlyMap<ModelSetId, LinkedModelSet>;
  readonly pools: ReadonlyMap<string, LinkedModelPool>;
  readonly agentRoutes: ReadonlyMap<AgentClientId, LinkedAgentRoute>;
}

/**
 * Complete linked configuration consumed by the composition root.
 *
 * Workflow authority is not part of this graph while Phenix has one built-in
 * workflow. The workflow runtime owns that definition directly.
 */
export interface LinkedPhenixGraph {
  readonly activeModelSet: LinkedModelSet;
  readonly contracts: ReadonlyMap<ContractDefinitionId, ContractDefinition>;
  readonly agentClients: ReadonlyMap<AgentClientId, LinkedAgentClient>;
  readonly routing: LinkedRoutingGraph;
}
