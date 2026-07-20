import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./support/default-workflow-fixture.ts";
import { createRunId, issueContract } from "@matthis-k/phenix-suite/subagents/contract.ts";
import { decodeContractArtifact } from "@matthis-k/phenix-suite/subagents/contract-codec.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

const preset = rolePreset(null);

describe("base child workflow state", () => {
  it("accepts the role-local executing state even without outgoing transitions", () => {
    const issued = issueContract({
      identity: {
        runId: createRunId(),
        handleId: "base-handle",
        role: null,
      },
      assignment: {
        task: "Complete a bounded non-code task",
        requirements: [],
        outputSchema: { type: "object" },
      },
      runtime: {
        agent: "phenix.base",
        cwd: "/tmp",
        thinking: "medium",
        tools: {
          role: null,
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
            role: null,
            source: {
              inherited: false,
              patch: { additional: [], removed: [] },
            },
            effective: [],
          },
          availableRoles: [],
          remainingDepth: 0,
        },
        workflow: {
          instanceId: "base-instance",
          actorId: "base-actor",
          definitionId: "phenix-default",
          difficulty: "D1",
          initialState: "executing",
          transitionAuthority: { kind: "restricted", allowed: [] },
          capabilityArtifactHash: "0".repeat(64),
        },
        timeoutMs: 60_000,
        turnBudget: {},
        toolBudget: { soft: 10, hard: 20, block: [] },
      },
      verification: {
        commands: [],
        criticRequired: false,
        maxRepairAttempts: 0,
      },
    });

    const decoded = decodeContractArtifact(issued.artifact);
    assert.equal(decoded.runtime.workflow.initialState, "executing");
  });
});
