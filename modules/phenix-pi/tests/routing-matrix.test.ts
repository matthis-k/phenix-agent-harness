import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ROLE_MATRIX, allMatrixKeys, validateMatrix } from "../extensions/phenix-routing/matrix.ts";
import {
  type Capability,
  type Difficulty,
  type RoutingRole,
} from "../extensions/phenix-routing/types.ts";
import { MODEL_SET_IDS } from "../extensions/phenix-routing/types.ts";
import { buildBundledConfig } from "../extensions/phenix-routing/config.ts";

const ALL_ROLES: RoutingRole[] = [
  "coordinator",
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "critic",
  "finalizer",
];

const ALL_DIFFICULTIES: Difficulty[] = ["D0", "D1", "D2", "D3"];

describe("Routing matrix cells (8 roles × 4 difficulties)", () => {
  it("every role/difficulty pair resolves to expected capability and thinking", () => {
    const expected: Record<RoutingRole, Record<Difficulty, { capability: Capability; thinking: string }>> = {
      coordinator: {
        D0: { capability: "fast",        thinking: "minimal" },
        D1: { capability: "general",     thinking: "low"     },
        D2: { capability: "reasoning",   thinking: "high"    },
        D3: { capability: "reasoning-max", thinking: "xhigh" },
      },
      scout: {
        D0: { capability: "fast",        thinking: "minimal" },
        D1: { capability: "fast",        thinking: "low"     },
        D2: { capability: "general",     thinking: "medium"  },
        D3: { capability: "reasoning",   thinking: "high"    },
      },
      planner: {
        D0: { capability: "general",     thinking: "low"     },
        D1: { capability: "general",     thinking: "medium"  },
        D2: { capability: "reasoning",   thinking: "high"    },
        D3: { capability: "reasoning-max", thinking: "xhigh" },
      },
      architect: {
        D0: { capability: "general",       thinking: "low"     },
        D1: { capability: "reasoning",     thinking: "medium"  },
        D2: { capability: "reasoning-max", thinking: "high"    },
        D3: { capability: "reasoning-max", thinking: "xhigh"   },
      },
      implementer: {
        D0: { capability: "code-fast", thinking: "low"     },
        D1: { capability: "code",      thinking: "low"     },
        D2: { capability: "code",      thinking: "medium"  },
        D3: { capability: "code-max",  thinking: "high"    },
      },
      tester: {
        D0: { capability: "fast",        thinking: "minimal" },
        D1: { capability: "code-fast",   thinking: "low"     },
        D2: { capability: "code",        thinking: "medium"  },
        D3: { capability: "code-max",    thinking: "high"    },
      },
      critic: {
        D0: { capability: "general",    thinking: "low"     },
        D1: { capability: "review",     thinking: "medium"  },
        D2: { capability: "review",     thinking: "high"    },
        D3: { capability: "review-max", thinking: "xhigh"   },
      },
      finalizer: {
        D0: { capability: "fast",       thinking: "minimal" },
        D1: { capability: "general",    thinking: "low"     },
        D2: { capability: "review",     thinking: "medium"  },
        D3: { capability: "review-max", thinking: "high"    },
      },
    };

    for (const role of ALL_ROLES) {
      for (const difficulty of ALL_DIFFICULTIES) {
        const route = ROLE_MATRIX[role]?.[difficulty];
        assert.ok(route, `Missing matrix entry for ${role}/${difficulty}`);
        const expect = expected[role][difficulty];
        assert.equal(route.capability, expect.capability, `${role}/${difficulty} capability mismatch`);
        assert.equal(route.thinking, expect.thinking, `${role}/${difficulty} thinking mismatch`);
      }
    }
  });

  it("allMatrixKeys returns all 32 pairs", () => {
    const keys = allMatrixKeys();
    assert.equal(keys.length, 8 * 4);
  });

  it("validateMatrix does not throw", () => {
    validateMatrix();
  });
});

describe("Model set capability mappings", () => {
  const config = buildBundledConfig();

  for (const setId of MODEL_SET_IDS) {
    it(`${setId} maps every capability to a pool`, () => {
      const ms = config.modelSets[setId];
      assert.ok(ms, `Missing modelSet ${setId}`);
      for (const cap of ["fast", "general", "reasoning", "reasoning-max", "code-fast", "code", "code-max", "review", "review-max"] as Capability[]) {
        const poolName = ms[cap];
        assert.ok(poolName, `${setId}/${cap} missing pool mapping`);
        assert.ok(config.pools[poolName], `Pool "${poolName}" for ${setId}/${cap} does not exist`);
      }
    });
  }

  for (const setId of MODEL_SET_IDS) {
    it(`${setId} every pool candidate parses as provider/model`, () => {
      const ms = config.modelSets[setId];
      for (const cap of ["fast", "general", "reasoning", "reasoning-max", "code-fast", "code", "code-max", "review", "review-max"] as Capability[]) {
        const poolName = ms[cap];
        const pool = config.pools[poolName];
        for (const candidate of pool) {
          const slash = candidate.indexOf("/");
          assert.ok(slash > 0 && slash < candidate.length - 1, `Malformed candidate "${candidate}" in ${poolName}`);
        }
      }
    });
  }
});

describe("Provider provider boundaries", () => {
  const config = buildBundledConfig();

  it("free routes never use a non-opencode provider", () => {
    const guard = config.guards?.free!;
    assert.deepEqual(guard.allowedProviders, ["opencode"]);
  });

  it("opencode-go routes never use a non-opencode-go provider", () => {
    const guard = config.guards?.["opencode-go"]!;
    assert.deepEqual(guard.allowedProviders, ["opencode-go"]);
  });

  it("gpt routes never use a Go provider", () => {
    const guard = config.guards?.gpt!;
    assert.deepEqual(guard.allowedProviders, ["openai", "openai-codex"]);
  });

  it("mixed routes allow both families", () => {
    const guard = config.guards?.mixed!;
    assert.deepEqual(guard.allowedProviders, ["opencode-go", "openai", "openai-codex"]);
  });
});
