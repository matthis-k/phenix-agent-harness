/**
 * phenix-composition — linker
 *
 * Resolves symbolic references, cross-validates declarations,
 * and produces an immutable linked graph.
 *
 * The linker is analogous to a compiler/linker. The runtime operates
 * only on the linked result.
 */

import type {
  AgentClientId,
  AgentKindId,
  ContractDefinitionId,
  WorkflowDefinitionId,
  ModelSetId,
  CapabilityId,
} from "../phenix-kernel/ids.ts";
import { agentClientId, modelSetId, capabilityId } from "../phenix-kernel/ids.ts";
import type {
  AgentClientRef,
  ContractDefinitionRef,
  ModelSetRef,
} from "../phenix-kernel/refs.ts";
import { refEquals } from "../phenix-kernel/refs.ts";
import type { LinkDiagnostic } from "../phenix-kernel/diagnostics.ts";
import type { PhenixConfiguration } from "./configuration.ts";
import type {
  LinkedPhenixGraph,
  LinkedAgentClient,
  LinkedModelSet,
  LinkedModelPool,
  LinkedAgentRoute,
  LinkedRoutingGraph,
  LinkedWorkflowDefinition,
} from "./linked-graph.ts";
import type { AgentClientDefinition } from "../phenix-subagents/definitions.ts";
import type { Difficulty, ThinkingLevel } from "../phenix-kernel/task.ts";
import { ALL_DIFFICULTIES } from "../phenix-kernel/task.ts";

// ── Link result ────────────────────────────────────────────────────────────

export type LinkResult =
  | {
      readonly ok: true;
      readonly graph: LinkedPhenixGraph;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly LinkDiagnostic[];
    };

// ── Error codes ────────────────────────────────────────────────────────────

const PHX_LINK = "PHX-LINK";

function diag(
  code: string,
  message: string,
  source: string,
  path: readonly string[] = [],
): LinkDiagnostic {
  return {
    code: `${PHX_LINK}-${code}`,
    severity: "error",
    source,
    path,
    message,
  };
}

function warn(
  code: string,
  message: string,
  source: string,
  path: readonly string[] = [],
): LinkDiagnostic {
  return {
    code: `${PHX_LINK}-${code}`,
    severity: "warning",
    source,
    path,
    message,
  };
}

// ── Link function ──────────────────────────────────────────────────────────

export function link(
  configuration: PhenixConfiguration,
): LinkResult {
  const errors: LinkDiagnostic[] = [];
  const warnings: LinkDiagnostic[] = [];

  const source = "phenix-composition";

  // ── Step 1: Validate there are no duplicate IDs ──────────────────────────

  const contractIds = new Set<string>();
  const clientIds = new Set<string>();
  const modelSetIdsSet = new Set<string>();
  const poolIds = new Set<string>();
  const routeClientIds = new Set<string>();

  for (const c of configuration.contracts) {
    if (contractIds.has(c.id)) {
      errors.push(diag("0001", `Duplicate contract definition ID: "${c.id}"`, source));
    }
    contractIds.add(c.id);
  }

  for (const c of configuration.agentClients) {
    if (clientIds.has(c.id)) {
      errors.push(diag("0002", `Duplicate agent client ID: "${c.id}"`, source));
    }
    clientIds.add(c.id);
  }

  for (const ms of configuration.routing.modelSets) {
    if (modelSetIdsSet.has(ms.id)) {
      errors.push(diag("0003", `Duplicate model set ID: "${ms.id}"`, source));
    }
    modelSetIdsSet.add(ms.id);
  }

  for (const p of configuration.routing.pools) {
    if (poolIds.has(p.id)) {
      errors.push(diag("0004", `Duplicate pool ID: "${p.id}"`, source));
    }
    poolIds.add(p.id);
  }

  for (const r of configuration.routing.agentRoutes) {
    if (routeClientIds.has(r.agentClient.id)) {
      errors.push(diag("0005", `Duplicate agent route for: "${r.agentClient.id}"`, source));
    }
    routeClientIds.add(r.agentClient.id);
  }

  // ── Step 2: Validate active model set exists ─────────────────────────────

  const activeSet = configuration.routing.modelSets.find(
    (ms) => ms.id === configuration.activeModelSet.id,
  );
  if (!activeSet) {
    errors.push(
      diag(
        "0006",
        `Active model set "${configuration.activeModelSet.id}" not found in model sets`,
        source,
      ),
    );
  }

  // ── Step 3: Validate agent clients reference existing contracts ──────────

  const contractDefMap = new Map<ContractDefinitionId, unknown>(
    configuration.contracts.map((c) => [c.id, c]),
  );

  for (const client of configuration.agentClients) {
    for (const ref of client.accepts) {
      if (!contractDefMap.has(ref.id as ContractDefinitionId)) {
        errors.push(
          diag(
            "0007",
            `Agent client "${client.id}" accepts unknown contract: "${ref.id}"`,
            source,
          ),
        );
      }
    }
    for (const ref of client.produces) {
      if (!contractDefMap.has(ref.id as ContractDefinitionId)) {
        errors.push(
          diag(
            "0008",
            `Agent client "${client.id}" produces unknown contract: "${ref.id}"`,
            source,
          ),
        );
      }
    }
  }

  // ── Step 4: Validate agent clients delegate to existing clients ──────────

  for (const client of configuration.agentClients) {
    for (const ref of client.delegation.allowedClients) {
      if (!clientIds.has(ref.id as string)) {
        errors.push(
          diag(
            "0009",
            `Agent client "${client.id}" delegates to unknown client: "${ref.id}"`,
            source,
          ),
        );
      }
    }
  }

  // ── Step 5: Validate pools and model sets ────────────────────────────────

  for (const pool of configuration.routing.pools) {
    if (pool.candidates.length === 0) {
      errors.push(
        diag(
          "0010",
          `Pool "${pool.id}" has no candidates`,
          source,
        ),
      );
    }
  }

  for (const ms of configuration.routing.modelSets) {
    for (const [cap, poolName] of Object.entries(ms.capabilityPools)) {
      const pool = configuration.routing.pools.find((p) => p.id === poolName);
      if (!pool) {
        errors.push(
          diag(
            "0011",
            `Model set "${ms.id}" references unknown pool "${poolName}" for capability "${cap}"`,
            source,
          ),
        );
      }
    }
  }

  // ── Step 6: Validate agent routes reference existing clients ─────────────

  for (const route of configuration.routing.agentRoutes) {
    if (!clientIds.has(route.agentClient.id as string)) {
      errors.push(
        diag(
          "0012",
          `Agent route references unknown client: "${route.agentClient.id}"`,
          source,
        ),
      );
    }
  }

  // ── Step 7: Validate route coverage ─────────────────────────────────────

  // Every agent client that appears in the configuration should have a route
  for (const client of configuration.agentClients) {
    const route = configuration.routing.agentRoutes.find(
      (r) => r.agentClient.id === (client.id as string),
    );
    if (!route) {
      errors.push(
        diag(
          "0013",
          `Agent client "${client.id}" has no route definition`,
          source,
        ),
      );
    }
  }

  // ── If errors, return failure ────────────────────────────────────────────

  if (errors.length > 0) {
    return {
      ok: false,
      diagnostics: [...warnings, ...errors],
    };
  }

  // ── Build linked graph ───────────────────────────────────────────────────

  const contracts = new Map(
    configuration.contracts.map((c) => [c.id, c]),
  ) as ReadonlyMap<ContractDefinitionId, unknown>;

  const agentClients = new Map<AgentClientId, LinkedAgentClient>(
    configuration.agentClients.map((c) => [
      c.id,
      {
        definition: c,
        accepts: new Set(c.accepts.map((r) => r.id as ContractDefinitionId)),
        produces: new Set(c.produces.map((r) => r.id as ContractDefinitionId)),
        allowedClients: new Set(
          c.delegation.allowedClients.map((r) => r.id as AgentClientId),
        ),
      } satisfies LinkedAgentClient,
    ]),
  );

  const modelSets = new Map<ModelSetId, LinkedModelSet>(
    configuration.routing.modelSets.map((ms) => [
      modelSetId(ms.id),
      {
        id: modelSetId(ms.id),
        capabilityPools: Object.fromEntries(
          Object.entries(ms.capabilityPools).map(([k, v]) => [capabilityId(k), v]),
        ) as Record<CapabilityId, string>,
        allowedProviders: ms.allowedProviders ?? [],
        guards: ms.guards,
      } satisfies LinkedModelSet,
    ]),
  );

  const pools = new Map<string, LinkedModelPool>(
    configuration.routing.pools.map((p) => [
      p.id,
      { id: p.id, candidates: p.candidates },
    ]),
  );

  const agentRoutes = new Map<AgentClientId, LinkedAgentRoute>(
    configuration.routing.agentRoutes.map((r) => [
      agentClientId(r.agentClient.id as string),
      {
        agentClientId: agentClientId(r.agentClient.id as string),
        difficulties: Object.fromEntries(
          ALL_DIFFICULTIES.map((d) => [
            d,
            {
              capability: capabilityId(
                r.difficulties[d]?.capability.id ?? "general",
              ),
              thinking: r.difficulties[d]?.thinking ?? "low",
            },
          ]),
        ) as Record<Difficulty, { capability: CapabilityId; thinking: ThinkingLevel }>,
      } satisfies LinkedAgentRoute,
    ]),
  );

  const routing: LinkedRoutingGraph = {
    modelSets,
    pools,
    agentRoutes,
  };

  const workflows = new Map<WorkflowDefinitionId, LinkedWorkflowDefinition>(
    configuration.workflows.map((w: any) => [
      w.id ?? "unknown",
      {
        id: w.id ?? "unknown",
        version: 1,
        initialState: w.initialState ?? "classified",
        raw: w,
      },
    ]),
  );

  const activeModelSetLinked = modelSets.get(
    configuration.activeModelSet.id as ModelSetId,
  )!;

  const graph: LinkedPhenixGraph = {
    activeModelSet: activeModelSetLinked,
    contracts: contracts as ReadonlyMap<ContractDefinitionId, any>,
    agentClients,
    routing,
    workflows,
  };

  // Deep-freeze
  return {
    ok: true,
    graph: deepFreeze(graph) as LinkedPhenixGraph,
  };
}

// ── Deep freeze helper ─────────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    if (obj instanceof Map) {
      for (const [key, value] of obj) {
        deepFreeze(value);
      }
      return obj;
    }
    for (const key of Object.keys(obj as object)) {
      deepFreeze((obj as any)[key]);
    }
  }
  return obj;
}
