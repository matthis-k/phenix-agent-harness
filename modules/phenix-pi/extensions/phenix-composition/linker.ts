/**
 * phenix-composition — linker
 *
 * Resolves symbolic references, cross-validates declarations, and produces the
 * immutable graph consumed by runtime composition. The linker is the only place
 * where passive configuration becomes indexed runtime data.
 */

import type { ContractDefinition } from "../phenix-contracts/definitions.ts";
import type {
  AgentClientId,
  CapabilityId,
  ContractDefinitionId,
  ModelSetId,
} from "../phenix-kernel/ids.ts";
import { capabilityId, modelSetId } from "../phenix-kernel/ids.ts";
import type { LinkDiagnostic } from "../phenix-kernel/diagnostics.ts";
import { ALL_DIFFICULTIES } from "../phenix-kernel/task.ts";
import type { Difficulty } from "../phenix-kernel/task.ts";
import type { PhenixConfiguration } from "./configuration.ts";
import type {
  LinkedAgentClient,
  LinkedAgentRoute,
  LinkedModelPool,
  LinkedModelSet,
  LinkedPhenixGraph,
  LinkedRoutingGraph,
} from "./linked-graph.ts";

export type LinkResult =
  | {
      readonly ok: true;
      readonly graph: LinkedPhenixGraph;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly LinkDiagnostic[];
    };

const DIAGNOSTIC_PREFIX = "PHX-LINK";
const DIAGNOSTIC_SOURCE = "phenix-composition";

function diagnostic(
  code: string,
  message: string,
  path: readonly string[] = [],
): LinkDiagnostic {
  return {
    code: `${DIAGNOSTIC_PREFIX}-${code}`,
    severity: "error",
    source: DIAGNOSTIC_SOURCE,
    path,
    message,
  };
}

function findDuplicates<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates];
}

function validateUniqueDeclarations(
  configuration: PhenixConfiguration,
  diagnostics: LinkDiagnostic[],
): void {
  for (const id of findDuplicates(configuration.contracts.map((contract) => contract.id))) {
    diagnostics.push(diagnostic("0001", `Duplicate contract definition ID: "${id}"`));
  }

  for (const id of findDuplicates(configuration.agentClients.map((client) => client.id))) {
    diagnostics.push(diagnostic("0002", `Duplicate agent client ID: "${id}"`));
  }

  for (const id of findDuplicates(configuration.routing.modelSets.map((modelSet) => modelSet.id))) {
    diagnostics.push(diagnostic("0003", `Duplicate model set ID: "${id}"`));
  }

  for (const id of findDuplicates(configuration.routing.pools.map((pool) => pool.id))) {
    diagnostics.push(diagnostic("0004", `Duplicate pool ID: "${id}"`));
  }

  for (const id of findDuplicates(
    configuration.routing.agentRoutes.map((route) => route.agentClient.id),
  )) {
    diagnostics.push(diagnostic("0005", `Duplicate agent route for: "${id}"`));
  }
}

function validateReferences(
  configuration: PhenixConfiguration,
  diagnostics: LinkDiagnostic[],
): void {
  const contractIds = new Set(configuration.contracts.map((contract) => contract.id));
  const clientIds = new Set(configuration.agentClients.map((client) => client.id));
  const poolIds = new Set(configuration.routing.pools.map((pool) => pool.id));
  const routeClientIds = new Set(
    configuration.routing.agentRoutes.map((route) => route.agentClient.id),
  );

  const activeModelSetExists = configuration.routing.modelSets.some(
    (modelSet) => modelSet.id === configuration.activeModelSet.id,
  );
  if (!activeModelSetExists) {
    diagnostics.push(
      diagnostic(
        "0006",
        `Active model set "${configuration.activeModelSet.id}" not found in model sets`,
      ),
    );
  }

  for (const client of configuration.agentClients) {
    for (const reference of client.accepts) {
      if (!contractIds.has(reference.id)) {
        diagnostics.push(
          diagnostic(
            "0007",
            `Agent client "${client.id}" accepts unknown contract: "${reference.id}"`,
          ),
        );
      }
    }

    for (const reference of client.produces) {
      if (!contractIds.has(reference.id)) {
        diagnostics.push(
          diagnostic(
            "0008",
            `Agent client "${client.id}" produces unknown contract: "${reference.id}"`,
          ),
        );
      }
    }

    for (const reference of client.delegation.allowedClients) {
      if (!clientIds.has(reference.id)) {
        diagnostics.push(
          diagnostic(
            "0009",
            `Agent client "${client.id}" delegates to unknown client: "${reference.id}"`,
          ),
        );
      }
    }

    if (!routeClientIds.has(client.id)) {
      diagnostics.push(
        diagnostic("0013", `Agent client "${client.id}" has no route definition`),
      );
    }
  }

  for (const pool of configuration.routing.pools) {
    if (pool.candidates.length === 0) {
      diagnostics.push(diagnostic("0010", `Pool "${pool.id}" has no candidates`));
    }
  }

  for (const modelSet of configuration.routing.modelSets) {
    for (const [capability, poolId] of Object.entries(modelSet.capabilityPools)) {
      if (!poolIds.has(poolId)) {
        diagnostics.push(
          diagnostic(
            "0011",
            `Model set "${modelSet.id}" references unknown pool "${poolId}" for capability "${capability}"`,
          ),
        );
      }
    }
  }

  for (const route of configuration.routing.agentRoutes) {
    if (!clientIds.has(route.agentClient.id)) {
      diagnostics.push(
        diagnostic(
          "0012",
          `Agent route references unknown client: "${route.agentClient.id}"`,
        ),
      );
    }
  }
}

function linkContracts(
  configuration: PhenixConfiguration,
): ReadonlyMap<ContractDefinitionId, ContractDefinition> {
  return new Map(
    configuration.contracts.map((contract) => [contract.id, contract] as const),
  );
}

function linkAgentClients(
  configuration: PhenixConfiguration,
): ReadonlyMap<AgentClientId, LinkedAgentClient> {
  return new Map(
    configuration.agentClients.map((client) => [
      client.id,
      {
        definition: client,
        accepts: new Set(client.accepts.map((reference) => reference.id)),
        produces: new Set(client.produces.map((reference) => reference.id)),
        allowedClients: new Set(
          client.delegation.allowedClients.map((reference) => reference.id),
        ),
      } satisfies LinkedAgentClient,
    ]),
  );
}

function linkModelSets(
  configuration: PhenixConfiguration,
): ReadonlyMap<ModelSetId, LinkedModelSet> {
  return new Map(
    configuration.routing.modelSets.map((definition) => {
      const id = modelSetId(definition.id);
      const capabilityPools = Object.fromEntries(
        Object.entries(definition.capabilityPools).map(([capability, pool]) => [
          capabilityId(capability),
          pool,
        ]),
      ) as Readonly<Record<CapabilityId, string>>;

      return [
        id,
        {
          id,
          capabilityPools,
          allowedProviders: definition.allowedProviders ?? [],
          guards: definition.guards,
        } satisfies LinkedModelSet,
      ] as const;
    }),
  );
}

function linkPools(
  configuration: PhenixConfiguration,
): ReadonlyMap<string, LinkedModelPool> {
  return new Map(
    configuration.routing.pools.map((pool) => [
      pool.id,
      {
        id: pool.id,
        candidates: pool.candidates,
      } satisfies LinkedModelPool,
    ]),
  );
}

function linkAgentRoutes(
  configuration: PhenixConfiguration,
): ReadonlyMap<AgentClientId, LinkedAgentRoute> {
  return new Map(
    configuration.routing.agentRoutes.map((definition) => {
      const difficulties = Object.fromEntries(
        ALL_DIFFICULTIES.map((difficulty) => {
          const route = definition.difficulties[difficulty];
          return [
            difficulty,
            {
              capability: route.capability.id,
              thinking: route.thinking,
            },
          ];
        }),
      ) as Readonly<
        Record<
          Difficulty,
          {
            readonly capability: CapabilityId;
            readonly thinking: (typeof definition.difficulties)[Difficulty]["thinking"];
          }
        >
      >;

      return [
        definition.agentClient.id,
        {
          agentClientId: definition.agentClient.id,
          difficulties,
        } satisfies LinkedAgentRoute,
      ] as const;
    }),
  );
}

/** Validate and link passive configuration into immutable runtime data. */
export function link(configuration: PhenixConfiguration): LinkResult {
  const diagnostics: LinkDiagnostic[] = [];

  validateUniqueDeclarations(configuration, diagnostics);
  validateReferences(configuration, diagnostics);

  if (diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics,
    };
  }

  const modelSets = linkModelSets(configuration);
  const activeModelSet = modelSets.get(configuration.activeModelSet.id);
  if (!activeModelSet) {
    // The reference check above guarantees this. Keep the assertion local to
    // the linking boundary instead of leaking optionality into runtime code.
    throw new Error(
      `Linked active model set "${configuration.activeModelSet.id}" is missing`,
    );
  }

  const graph: LinkedPhenixGraph = {
    activeModelSet,
    contracts: linkContracts(configuration),
    agentClients: linkAgentClients(configuration),
    routing: {
      modelSets,
      pools: linkPools(configuration),
      agentRoutes: linkAgentRoutes(configuration),
    } satisfies LinkedRoutingGraph,
  };

  return {
    ok: true,
    graph: deepFreeze(graph),
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  if (value instanceof Map) {
    for (const [key, entry] of value) {
      deepFreeze(key);
      deepFreeze(entry);
    }
    Object.freeze(value);
    return value;
  }

  if (value instanceof Set) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    Object.freeze(value);
    return value;
  }

  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }

  return Object.freeze(value);
}
