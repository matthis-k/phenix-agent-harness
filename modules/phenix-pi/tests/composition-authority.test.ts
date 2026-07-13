import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definePhenixConfiguration, link } from "../extensions/phenix-composition/index.ts";
import { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "../extensions/phenix-composition/runtime-policy.ts";
import { defaultContracts } from "../extensions/phenix-contracts/default-contracts.ts";
import { modelSetRef } from "../extensions/phenix-kernel/refs.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "../extensions/phenix-routing/default-routing.ts";
import { defaultAgentClients } from "../extensions/phenix-subagents/definitions.ts";

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
