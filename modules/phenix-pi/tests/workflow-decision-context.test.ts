import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDelegationOptions } from "@matthis-k/phenix-flow/delegation-options.ts";
import {
  buildWorkflowDecisionContext,
  computeOptionsDigest,
  projectDelegationOptions,
} from "@matthis-k/phenix-flow/workflow-projection.ts";
import type {
  DelegationAuthority,
  WorkflowRuntimeRecord,
} from "@matthis-k/phenix-flow/workflow-types.ts";
import { PHENIX_DEFAULT_WORKFLOW } from "./support/default-workflow-fixture.ts";

function baseRecord(overrides?: Partial<WorkflowRuntimeRecord>): WorkflowRuntimeRecord {
  return {
    instanceId: "test-instance",
    actorId: "test-actor",
    sessionId: "test-session",
    definitionId: "phenix-default",
    difficulty: "D2",
    taskProfile: {
      complexity: 2,
      uncertainty: 1,
      consequence: 2,
      breadth: 2,
      coupling: 1,
      novelty: 1,
    },
    actorRole: "coordinator",
    state: "classified",
    revision: 0,
    facts: {},
    active: [],
    completed: [],
    capabilityArtifactHash: "0".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function unrestrictedAuthority(): DelegationAuthority {
  return {
    roles: {
      role: null,
      source: { inherited: false, patch: { additional: [], removed: [] } },
      effective: ["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"],
    },
    availableRoles: [
      "scout",
      "planner",
      "architect",
      "implementer",
      "tester",
      "critic",
      "finalizer",
    ],
    remainingDepth: 4,
    transitionAuthority: { kind: "unrestricted" },
  };
}

describe("WorkflowDecisionContext", () => {
  it("builds target-agent options from the current node", () => {
    const ctx = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    assert.ok(ctx.options.length > 0);
    assert.equal(ctx.currentState, "classified");
    assert.equal(ctx.difficulty, "D2");
    assert.equal(ctx.revision, 0);
    assert.equal(ctx.options[0]?.sourceNodeId, "classified");
    assert.ok(ctx.optionsDigest.length === 64);
  });

  it("produces deterministic authority digests", () => {
    const input = {
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    };
    assert.equal(
      buildWorkflowDecisionContext(input).optionsDigest,
      buildWorkflowDecisionContext(input).optionsDigest,
    );
  });

  it("projects different target sets for different nodes", () => {
    const classified = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });
    const planning = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "planning" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const classifiedAgents = new Set(classified.options.map((option) => option.agent));
    const planningAgents = new Set(planning.options.map((option) => option.agent));
    assert.notDeepEqual([...classifiedAgents].sort(), [...planningAgents].sort());
  });

  it("changes the digest when target identity changes", () => {
    const base = {
      agent: "scout",
      transitionId: "edge-a",
      sourceNodeId: "node-a",
      targetNodeId: "node-b",
      workflowRevision: 0,
      role: "scout",
      purpose: "evidence",
      description: "Gather evidence",
      category: "optional" as const,
      outputSchemaId: "scout-handoff" as const,
      allowedModes: ["await" as const],
      resultSchema: { type: "object" },
    };
    assert.equal(computeOptionsDigest([base]), computeOptionsDigest([base]));
    assert.notEqual(
      computeOptionsDigest([base]),
      computeOptionsDigest([{ ...base, agent: "planner-scout" }]),
    );
  });

  it("fails closed when no roles or depth are available", () => {
    const restrictedAuth: DelegationAuthority = {
      roles: {
        role: null,
        source: { inherited: false, patch: { additional: [], removed: [] } },
        effective: [],
      },
      availableRoles: [],
      remainingDepth: 0,
      transitionAuthority: { kind: "restricted", allowed: [] },
    };

    const ctx = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: restrictedAuth,
      activeHandles: [],
    });

    assert.equal(ctx.options.length, 0);
    assert.ok(ctx.optionsDigest);
  });

  it("preserves internal transition and public target metadata", () => {
    const rawOptions = resolveDelegationOptions({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const projected = projectDelegationOptions(PHENIX_DEFAULT_WORKFLOW, "classified", rawOptions);
    assert.ok(projected.length > 0);

    for (const option of projected) {
      assert.ok(typeof option.agent === "string" && option.agent.length > 0);
      assert.ok(typeof option.transitionId === "string" && option.transitionId.length > 0);
      assert.equal(option.sourceNodeId, "classified");
      assert.ok(typeof option.targetNodeId === "string");
      assert.ok(typeof option.role === "string");
      assert.ok(Array.isArray(option.allowedModes));
      assert.ok(option.resultSchema && typeof option.resultSchema === "object");
    }
  });

  it("specializes parallel D3 scouts without changing their execution role", () => {
    const ctx = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ difficulty: "D3", state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const scoutTargets = ctx.options
      .filter((option) => option.role === "scout")
      .map((option) => option.agent)
      .sort();
    assert.deepEqual(scoutTargets, ["constraint-scout", "repository-scout", "test-scout"]);
  });
});
