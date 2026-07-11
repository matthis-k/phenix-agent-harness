import type { Difficulty, RoleRoute, RoutingRole } from "./types.ts";

/**
 * Fixed role matrix mapping (role × difficulty) → (capability, thinking).
 *
 * This is the single source of truth for semantic routing. A role having a
 * route does not mean that role must be spawned — the workflow state machine
 * determines activation.
 */
export const ROLE_MATRIX: Readonly<
  Record<RoutingRole, Readonly<Record<Difficulty, RoleRoute>>>
> = {
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

/** List all (role, difficulty) pairs in the matrix. */
export function allMatrixKeys(): Array<{ role: RoutingRole; difficulty: Difficulty }> {
  const keys: Array<{ role: RoutingRole; difficulty: Difficulty }> = [];
  for (const [role, diffs] of Object.entries(ROLE_MATRIX)) {
    for (const difficulty of Object.keys(diffs) as Difficulty[]) {
      keys.push({ role: role as RoutingRole, difficulty });
    }
  }
  return keys;
}

/** Validate that every matrix cell resolves. Throws on missing entries. */
export function validateMatrix(): void {
  for (const role of Object.keys(ROLE_MATRIX) as RoutingRole[]) {
    for (const difficulty of ["D0", "D1", "D2", "D3"] as Difficulty[]) {
      const route = ROLE_MATRIX[role]?.[difficulty];
      if (!route) {
        throw new Error(`Matrix missing entry for ${role}/${difficulty}`);
      }
      if (!route.capability || !route.thinking) {
        throw new Error(`Matrix entry ${role}/${difficulty} has incomplete route`);
      }
    }
  }
}
