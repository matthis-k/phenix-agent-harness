import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentClientId, contractDefinitionId } from "@matthis-k/phenix-kernel/ids.ts";
import { modelSetRef } from "@matthis-k/phenix-kernel/refs.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "@matthis-k/phenix-routing/default-routing.ts";
import {
  definePhenixConfiguration,
  link,
} from "@matthis-k/phenix-suite/composition/index.ts";
import { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "@matthis-k/phenix-suite/composition/runtime-policy.ts";
import { defaultAgentClients } from "@matthis-k/phenix-suite/defaults/agents.ts";
import { defaultContracts } from "@matthis-k/phenix-suite/defaults/contracts.ts";

function defaultConfiguration() {
  return definePhenixConfiguration({
    activeModelSet: modelSetRef("mixed"),
    contracts: defaultContracts,
    agentClients: defaultAgentClients,
    routing: {
      modelSets: defaultModelSets,
      pools: defaultModelPools,
      agentRoutes: defaultAgentRoutes,
    },
    runtime: {
      maximumDelegationDepth: DEFAULT_MAXIMUM_DELEGATION_DEPTH,
      persistChildSessions: true,
    },
  });
}

describe("composition authority", () => {
  it("links only declarations consumed by runtime composition", () => {
    const result = link(defaultConfiguration());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(Object.hasOwn(result.graph, "workflows"), false);
    assert.equal(result.graph.contracts.size, defaultContracts.length);
    assert.equal(result.graph.agentClients.size, defaultAgentClients.length);
    assert.equal(result.graph.routing.modelSets.size, defaultModelSets.length);
    assert.equal(result.graph.routing.pools.size, defaultModelPools.length);
    assert.equal(result.graph.routing.agentRoutes.size, defaultAgentRoutes.length);
    assert.equal(result.graph.agentClients.has(agentClientId("coordinator")), true);
    assert.equal(result.graph.contracts.has(contractDefinitionId("planner-handoff")), true);
  });

  it("freezes linked declarations at the composition boundary", () => {
    const result = link(defaultConfiguration());
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(Object.isFrozen(result.graph), true);
    assert.equal(Object.isFrozen(result.graph.contracts), true);
    assert.equal(Object.isFrozen(result.graph.agentClients), true);
    assert.equal(Object.isFrozen(result.graph.routing), true);
    assert.equal(Object.isFrozen(result.graph.routing.modelSets), true);
  });

  it("rejects active model sets that are not declared", () => {
    const result = link({
      ...defaultConfiguration(),
      activeModelSet: modelSetRef("missing"),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.diagnostics.map((entry) => entry.message).join("\n"), /not found/);
  });
});
