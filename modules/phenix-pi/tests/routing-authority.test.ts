import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBundledConfig, validateConfig } from "@matthis-k/phenix-routing/config.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "@matthis-k/phenix-suite/defaults/routing.ts";
import { ROLE_MATRIX } from "@matthis-k/phenix-routing/matrix.ts";
import { capabilityFromId, routingRoleFromId } from "@matthis-k/phenix-routing/types.ts";

describe("routing declaration authority", () => {
  it("projects every pool without changing candidates", () => {
    const config = buildBundledConfig();

    assert.deepEqual(
      config.pools,
      Object.fromEntries(
        defaultModelPools.map((definition) => [definition.id, definition.candidates]),
      ),
    );
  });

  it("projects every model set, provider boundary, and guard", () => {
    const config = buildBundledConfig();

    for (const definition of defaultModelSets) {
      assert.deepEqual(config.modelSets[definition.id], definition.capabilityPools);
      assert.deepEqual(config.guards?.[definition.id], {
        ...(definition.allowedProviders ? { allowedProviders: definition.allowedProviders } : {}),
        ...(definition.guards?.denySecrecy ? { denySecrecy: definition.guards.denySecrecy } : {}),
        ...(definition.guards?.denyChangeKinds
          ? { denyChangeKinds: definition.guards.denyChangeKinds }
          : {}),
        ...(definition.guards?.denyTargetStates
          ? { denyTargetStates: definition.guards.denyTargetStates }
          : {}),
      });
    }

    assert.deepEqual(validateConfig(config), []);
  });

  it("projects the role matrix from agent-route declarations", () => {
    for (const definition of defaultAgentRoutes) {
      const role = routingRoleFromId(definition.agentClient.id);
      for (const [difficulty, declared] of Object.entries(definition.difficulties)) {
        assert.deepEqual(ROLE_MATRIX[role][difficulty as keyof typeof definition.difficulties], {
          capability: capabilityFromId(declared.capability.id),
          thinking: declared.thinking,
        });
      }
    }
  });
});
