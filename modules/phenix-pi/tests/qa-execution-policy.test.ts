import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentClientRef } from "@matthis-k/phenix-kernel/refs.ts";
import { baseClient } from "@matthis-k/phenix-suite/defaults/agents.ts";
import { resolveDelegateRoleConfiguration } from "@matthis-k/phenix-suite/subagents/delegation-policy.ts";
import { resolveExecutionPolicy } from "@matthis-k/phenix-suite/subagents/policy.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

const QA_SPECIALISTS = ["scout", "tester", "architect", "critic"] as const;

describe("QA execution policy", () => {
  it("authorizes the base integrator to delegate isolated QA concerns", () => {
    assert.deepEqual(rolePreset(null).allowedChildren, QA_SPECIALISTS);
    assert.deepEqual(
      resolveDelegateRoleConfiguration({
        role: null,
        requested: null,
      }).effective,
      QA_SPECIALISTS,
    );
    assert.deepEqual(baseClient.delegation.allowedClients, [
      agentClientRef("scout"),
      agentClientRef("tester"),
      agentClientRef("architect"),
      agentClientRef("critic"),
    ]);
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
