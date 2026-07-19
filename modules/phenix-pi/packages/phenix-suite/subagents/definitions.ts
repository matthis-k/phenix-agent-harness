import type { AgentClientId, AgentKindId } from "@matthis-k/phenix-kernel/ids.ts";
import type { AgentClientRef, ContractDefinitionRef } from "@matthis-k/phenix-kernel/refs.ts";

/** Passive declaration of an executable agent client. */
export interface AgentClientDefinition {
  readonly id: AgentClientId;
  readonly kind: AgentKindId;

  /** Concrete bundled or discovered Pi agent name. */
  readonly agent: `phenix.${string}` | "phenix.base";

  readonly instructions?: {
    readonly agentFile?: string;
    readonly systemFragments?: readonly string[];
  };

  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly extensions: readonly string[];

  readonly accepts: readonly ContractDefinitionRef[];
  readonly produces: readonly ContractDefinitionRef[];

  readonly delegation: {
    readonly allowedClients: readonly AgentClientRef[];
    readonly maxDepth?: number;
  };

  readonly maxTurnBudget?: number;
  readonly maxToolBudget?: number;
}

export function defineAgentClient(definition: AgentClientDefinition): AgentClientDefinition {
  return definition;
}
