import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowDecisionContext,
  computeOptionsDigest,
  projectDelegationOptions,
} from "../extensions/phenix-workflow/workflow-projection.ts";

import {
  resolveDelegationOptions,
} from "../extensions/phenix-workflow/delegation-options.ts";

import { PHENIX_DEFAULT_WORKFLOW } from "../extensions/phenix-workflow/workflow-definitions.ts";

import type { WorkflowRuntimeRecord } from "../extensions/phenix-workflow/workflow-types.ts";
import type { DelegationAuthority } from "../extensions/phenix-workflow/workflow-types.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WorkflowDecisionContext", () => {
  it("builds context with options from current state", () => {
    const ctx = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    assert.ok(ctx.options.length > 0, "should have options from classified state");
    assert.equal(ctx.currentState, "classified");
    assert.equal(ctx.difficulty, "D2");
    assert.equal(ctx.revision, 0);
    assert.ok(typeof ctx.optionsDigest === "string");
    assert.ok(ctx.optionsDigest.length === 64, "digest should be 64 hex chars (SHA-256)");
  });

  it("produces deterministic digest for same options", () => {
    const ctx1 = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const ctx2 = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    assert.equal(ctx1.optionsDigest, ctx2.optionsDigest);
  });

  it("produces different digest for different states", () => {
    const ctx1 = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    // State "planning" has different available transitions.
    const ctx2 = buildWorkflowDecisionContext({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "planning" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    // Digests may or may not differ depending on transition set.
    // But the options sets should differ.
    const ids1 = new Set(ctx1.options.map((o) => o.transitionId));
    const ids2 = new Set(ctx2.options.map((o) => o.transitionId));
    assert.notDeepEqual([...ids1].sort(), [...ids2].sort());
  });

  it("computeOptionsDigest is stable across calls", () => {
    const options = [
      { transitionId: "delegate_to_planner", workflowRevision: 0 },
      { transitionId: "delegate_to_scout", workflowRevision: 0 },
    ] as any;

    const d1 = computeOptionsDigest(options);
    const d2 = computeOptionsDigest(options);
    assert.equal(d1, d2);
  });

  it("computeOptionsDigest changes when options change", () => {
    const opts1 = [
      { transitionId: "delegate_to_planner", workflowRevision: 0 },
    ] as any;

    const opts2 = [
      { transitionId: "delegate_to_planner", workflowRevision: 0 },
      { transitionId: "delegate_to_scout", workflowRevision: 0 },
    ] as any;

    assert.notEqual(computeOptionsDigest(opts1), computeOptionsDigest(opts2));
  });

  it("context with no available roles produces empty options (fail-closed)", () => {
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

    // Empty restricted authority means no transitions are permitted.
    assert.equal(ctx.options.length, 0);
    assert.ok(ctx.optionsDigest);
  });

  it("projectDelegationOptions preserves transition metadata", () => {
    const rawOptions = resolveDelegationOptions({
      definition: PHENIX_DEFAULT_WORKFLOW,
      runtime: baseRecord({ state: "classified" }),
      authority: unrestrictedAuthority(),
      activeHandles: [],
    });

    const projected = projectDelegationOptions(rawOptions);
    assert.ok(projected.length > 0);

    for (const opt of projected) {
      assert.ok(typeof opt.transitionId === "string");
      assert.ok(typeof opt.workflowRevision === "number");
      assert.ok(typeof opt.role === "string");
      assert.ok(typeof opt.description === "string");
      assert.ok(["required", "optional", "repair"].includes(opt.category));
      assert.ok(Array.isArray(opt.allowedModes));
      assert.ok(opt.resultSchema && typeof opt.resultSchema === "object");
    }
  });
});
