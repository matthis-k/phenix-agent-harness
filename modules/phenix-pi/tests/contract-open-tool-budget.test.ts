import assert from "node:assert/strict";
import "./support/default-workflow-fixture.ts";
import { describe, it } from "node:test";
import { createRunId, issueContract } from "@matthis-k/phenix-suite/subagents/contract.ts";
import { decodeContractArtifact } from "@matthis-k/phenix-suite/subagents/contract-codec.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

describe("contract tool budgets", () => {
  it("accepts an advisory-only tool budget", () => {
    const preset = rolePreset("scout");
    const issued = issueContract({
      identity: {
        runId: createRunId(),
        handleId: "open-budget-handle",
        role: "scout",
      },
      assignment: {
        task: "Inspect repository evidence.",
        requirements: [],
        outputSchema: { type: "object" },
      },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp/repository",
        thinking: "medium",
        tools: {
          role: "scout",
          source: {
            inherited: false,
            patch: { additional: [], removed: [] },
          },
          effective: [...preset.tools],
        },
        skills: [],
        extensions: [],
        delegation: {
          roles: {
            role: "scout",
            source: {
              inherited: false,
              patch: { additional: [], removed: [] },
            },
            effective: ["scout"],
          },
          availableRoles: [],
          remainingDepth: 1,
        },
        workflow: {
          instanceId: "open-budget-workflow",
          actorId: "open-budget-actor",
          definitionId: "phenix-default",
          difficulty: "D1",
          initialState: "scouting",
          transitionAuthority: { kind: "unrestricted" },
          capabilityArtifactHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
        timeoutMs: 600_000,
        turnBudget: {},
        toolBudget: { soft: 60, block: [] },
      },
      verification: {
        commands: [],
        criticRequired: false,
        maxRepairAttempts: 1,
      },
    });

    const decoded = decodeContractArtifact(JSON.parse(JSON.stringify(issued.artifact)));
    assert.equal(decoded.runtime.toolBudget.soft, 60);
    assert.equal(decoded.runtime.toolBudget.hard, undefined);
  });
});
