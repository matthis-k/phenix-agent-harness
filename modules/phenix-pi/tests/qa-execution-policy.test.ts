import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentClientRef } from "@matthis-k/phenix-kernel/refs.ts";
import { baseClient } from "@matthis-k/phenix-suite/defaults/agents.ts";
import { resolveDelegateRoleConfiguration } from "@matthis-k/phenix-suite/subagents/delegation-policy.ts";
import { resolveExecutionPolicy } from "@matthis-k/phenix-suite/subagents/policy.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

const BASE_CHILDREN = [
  null,
  "scout",
  "planner",
  "architect",
  "implementer",
  "tester",
  "critic",
  "finalizer",
] as const;

const BASE_CLIENTS = [
  agentClientRef("base"),
  agentClientRef("scout"),
  agentClientRef("planner"),
  agentClientRef("architect"),
  agentClientRef("implementer"),
  agentClientRef("tester"),
  agentClientRef("critic"),
  agentClientRef("finalizer"),
] as const;

describe("QA execution policy", () => {
  it("authorizes the base integrator for preset-specific and dynamic child workflows", () => {
    assert.deepEqual(rolePreset(null).allowedChildren, BASE_CHILDREN);
    assert.deepEqual(
      resolveDelegateRoleConfiguration({
        role: null,
        requested: null,
      }).effective,
      BASE_CHILDREN,
    );
    assert.deepEqual(baseClient.delegation.allowedClients, BASE_CLIENTS);
  });

  it("uses an advisory-only tool budget by default", () => {
    const policy = resolveExecutionPolicy({
      role: null,
      task: "Perform a full repository QA review.",
      requirements: [],
      cwd: "/tmp/repository",
      config: {},
    });

    assert.ok(policy.toolBudget.soft > 0);
    assert.equal(policy.toolBudget.hard, undefined);
  });

  it("supports an explicit hard tool cap when a bounded task requires one", () => {
    const policy = resolveExecutionPolicy({
      role: null,
      task: "Perform a bounded inspection.",
      requirements: [],
      cwd: "/tmp/repository",
      config: {
        execution: {
          toolBudget: { hard: 12 },
        },
      },
    });

    assert.equal(policy.toolBudget.soft, 12);
    assert.equal(policy.toolBudget.hard, 12);
  });
});
