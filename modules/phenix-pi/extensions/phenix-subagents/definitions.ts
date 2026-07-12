/**
 * phenix-subagents — agent client definitions
 *
 * First-class AgentClientDefinition declares what an agent client
 * is, what contracts it accepts/produces, what tools and skills it
 * has, and what delegation ceiling it imposes.
 *
 * Agent clients are configuration data, not runtime logic.
 */

import type {
  AgentClientId,
  AgentKindId,
} from "../phenix-kernel/ids.ts";
import type {
  AgentClientRef,
  ContractDefinitionRef,
} from "../phenix-kernel/refs.ts";
import { agentClientRef, contractRef } from "../phenix-kernel/refs.ts";
import { agentClientId, agentKindId } from "../phenix-kernel/ids.ts";

// ── Agent client definition ────────────────────────────────────────────────

export interface AgentClientDefinition {
  readonly id: AgentClientId;
  readonly kind: AgentKindId;

  /**
   * Concrete bundled or discovered Pi agent name.
   */
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

// ── Helper ─────────────────────────────────────────────────────────────────

export function defineAgentClient(
  def: AgentClientDefinition,
): AgentClientDefinition {
  return def;
}

// ── Default agent clients ─────────────────────────────────────────────────

export const coordinatorClient = defineAgentClient({
  id: agentClientId("coordinator"),
  kind: agentKindId("coordinator"),
  agent: "phenix.base",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [],
  produces: [
    contractRef("planner-handoff"),
    contractRef("architecture-handoff"),
    contractRef("implementation-handoff"),
    contractRef("test-handoff"),
    contractRef("finalizer-handoff"),
    contractRef("critic-handoff"),
  ],
  delegation: {
    allowedClients: [
      agentClientRef("scout"),
      agentClientRef("planner"),
      agentClientRef("architect"),
      agentClientRef("implementer"),
      agentClientRef("tester"),
      agentClientRef("critic"),
      agentClientRef("finalizer"),
    ],
    maxDepth: 3,
  },
});

export const baseClient = defineAgentClient({
  id: agentClientId("base"),
  kind: agentKindId("base"),
  agent: "phenix.base",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [],
  produces: [contractRef("base-handoff")],
  delegation: { allowedClients: [], maxDepth: 0 },
});

export const scoutClient = defineAgentClient({
  id: agentClientId("scout"),
  kind: agentKindId("scout"),
  agent: "phenix.scout",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [],
  produces: [contractRef("scout-handoff")],
  delegation: {
    allowedClients: [agentClientRef("scout")],
    maxDepth: 1,
  },
});

export const plannerClient = defineAgentClient({
  id: agentClientId("planner"),
  kind: agentKindId("planner"),
  agent: "phenix.planner",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [contractRef("scout-handoff")],
  produces: [contractRef("planner-handoff")],
  delegation: {
    allowedClients: [
      agentClientRef("scout"),
      agentClientRef("architect"),
      agentClientRef("critic"),
    ],
    maxDepth: 2,
  },
});

export const architectClient = defineAgentClient({
  id: agentClientId("architect"),
  kind: agentKindId("architect"),
  agent: "phenix.architect",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [contractRef("scout-handoff")],
  produces: [contractRef("architecture-handoff")],
  delegation: {
    allowedClients: [
      agentClientRef("scout"),
      agentClientRef("critic"),
    ],
    maxDepth: 2,
  },
});

export const implementerClient = defineAgentClient({
  id: agentClientId("implementer"),
  kind: agentKindId("implementer"),
  agent: "phenix.implementer",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [
    contractRef("planner-handoff"),
    contractRef("architecture-handoff"),
    contractRef("scout-handoff"),
  ],
  produces: [contractRef("implementation-handoff")],
  delegation: {
    allowedClients: [
      agentClientRef("scout"),
      agentClientRef("tester"),
      agentClientRef("critic"),
    ],
    maxDepth: 2,
  },
});

export const testerClient = defineAgentClient({
  id: agentClientId("tester"),
  kind: agentKindId("tester"),
  agent: "phenix.tester",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [contractRef("implementation-handoff")],
  produces: [contractRef("test-handoff")],
  delegation: {
    allowedClients: [agentClientRef("scout")],
    maxDepth: 1,
  },
});

export const criticClient = defineAgentClient({
  id: agentClientId("critic"),
  kind: agentKindId("critic"),
  agent: "phenix.critic",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [
    contractRef("planner-handoff"),
    contractRef("architecture-handoff"),
    contractRef("implementation-handoff"),
    contractRef("test-handoff"),
    contractRef("finalizer-handoff"),
  ],
  produces: [contractRef("critic-handoff")],
  delegation: {
    allowedClients: [
      agentClientRef("scout"),
      agentClientRef("tester"),
    ],
    maxDepth: 1,
  },
});

export const finalizerClient = defineAgentClient({
  id: agentClientId("finalizer"),
  kind: agentKindId("finalizer"),
  agent: "phenix.finalizer",
  tools: ["*"],
  skills: [],
  extensions: [],
  accepts: [
    contractRef("implementation-handoff"),
    contractRef("test-handoff"),
    contractRef("critic-handoff"),
  ],
  produces: [contractRef("finalizer-handoff")],
  delegation: {
    allowedClients: [agentClientRef("critic")],
    maxDepth: 1,
  },
});

// ── Default collection ────────────────────────────────────────────────────

export const defaultAgentClients: readonly AgentClientDefinition[] = [
  coordinatorClient,
  baseClient,
  scoutClient,
  plannerClient,
  architectClient,
  implementerClient,
  testerClient,
  criticClient,
  finalizerClient,
];
