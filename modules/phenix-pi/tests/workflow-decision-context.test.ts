import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDelegationOptions } from "../extensions/phenix-workflow/delegation-options.ts";
import { PHENIX_DEFAULT_WORKFLOW } from "../extensions/phenix-workflow/workflow-definitions.ts";
import {
  buildWorkflowDecisionContext,
  computeOptionsDigest,
  projectDelegationOptions,
} from "../extensions/phenix-workflow/workflow-projection.ts";
import type {
  DelegationAuthority,
  WorkflowRuntimeRecord,
} from "../extensions/phenix-workflow/workflow-types.ts";

function baseRecord(overrides?: Partial<WorkflowRuntimeRecord>): WorkflowRuntimeRecord {
  return {
    version: 1,
    instanceId: "test-instance",
    actorId: "test-actor",
    sessionId: "test-session",
    definitionId: "phenix-default",
    definitionVersion: 1,
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
      presetRevision: 1,
      role: null,
      source: { inherited: false, patch: { additional: [], removed: [] } },
      effective: ["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"],
    },
    availableRoles: ["scout", "planner", "architect", "implementer", "tester", "critic", "finalizer"],
    remainingDepth: 4,
    transitionAuthority: { kind: "unrestricted" },
  };
}

describe("WorkflowDecisionContext", () => {
  it("builds outgoing edges from the current node", () => {
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

  it("projects different outgoing edge sets for different nodes", () => {
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

    const classifiedEdges = new Set(classified.options.map((option) => option.edgeId));
    const planningEdges = new Set(planning.options.map((option) => option.edgeId));
    assert.notDeepEqual([...classifiedEdges].sort(), [...planningEdges].sort());
  });

  it("changes the digest when an edge changes", () => {
    const base = {
      edgeId: "edge-a",
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
      computeOptionsDigest([{ ...base, edgeId: "edge-b", transitionId: "edge-b" }]),
    );
  });

  it("fails closed when no roles or depth are available", () => {
    const restrictedAuth: DelegationAuthority = {
      roles: {
        presetRevision: 1,
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

  it("preserves graph and spawn metadata", () => {
    const rawOptions = resolveDelegationOptions({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const projected = projectDelegationOptions("classified", rawOptions);
    assert.ok(projected.length > 0);

    for (const edge of projected) {
      assert.equal(edge.edgeId, edge.transitionId);
      assert.equal(edge.sourceNodeId, "classified");
      assert.ok(typeof edge.targetNodeId === "string");
      assert.ok(typeof edge.role === "string");
      assert.ok(Array.isArray(edge.allowedModes));
      assert.ok(edge.resultSchema && typeof edge.resultSchema === "object");
    }
  });
});
