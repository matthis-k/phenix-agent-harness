/**
 * Tests for workflow definitions integrity.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHENIX_DEFAULT_WORKFLOW,
  validateDefinition,
} from "@matthis-k/phenix-flow/workflow-definitions.ts";

describe("Workflow definitions", () => {
  it("has no duplicate transition IDs", () => {
    const errors = validateDefinition(PHENIX_DEFAULT_WORKFLOW);
    assert.equal(errors.length, 0, `Validation errors: ${errors.join("; ")}`);
  });

  it("has unique transition IDs", () => {
    const ids = new Set<string>();
    for (const t of PHENIX_DEFAULT_WORKFLOW.transitions) {
      assert.ok(!ids.has(t.id), `Duplicate transition ID: ${t.id}`);
      ids.add(t.id);
    }
  });

  it("has a D0 path to completed via base execution", () => {
    const d0Base = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d0.execute-base");
    assert.ok(d0Base, "D0 base execution transition exists");
    if (d0Base && d0Base.kind === "delegate") {
      assert.equal(d0Base.onAccepted, "completed");
      assert.ok(d0Base.difficulty.includes("D0"));
    }
  });

  it("has a D0 path to completed via implementer execution", () => {
    const d0Impl = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d0.execute-code");
    assert.ok(d0Impl, "D0 code execution transition exists");
    if (d0Impl && d0Impl.kind === "delegate") {
      assert.equal(d0Impl.onAccepted, "completed");
      assert.ok(d0Impl.difficulty.includes("D0"));
    }
  });

  it("has D2 plan before implementation", () => {
    const plan = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d2.plan");
    const impl = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d2.implement-from-plan");
    assert.ok(plan, "D2 plan transition exists");
    assert.ok(impl, "D2 implement transition exists");
    if (plan && plan.kind === "delegate") {
      assert.ok(plan.from.includes("classified"));
      assert.equal(plan.onAccepted, "plan-ready");
    }
    if (impl && impl.kind === "delegate") {
      assert.ok(impl.from.includes("plan-ready"));
    }
  });

  it("has D3 required scouts before planner", () => {
    const scoutRepo = PHENIX_DEFAULT_WORKFLOW.transitions.find(
      (t) => t.id === "d3.scout-repository",
    );
    const scoutTests = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d3.scout-tests");
    const scoutConstraints = PHENIX_DEFAULT_WORKFLOW.transitions.find(
      (t) => t.id === "d3.scout-constraints",
    );
    assert.ok(scoutRepo, "D3 repository scout exists");
    assert.ok(scoutTests, "D3 tests scout exists");
    assert.ok(scoutConstraints, "D3 constraints scout exists");
  });

  it("has D3 final review after finalizer", () => {
    const finalize = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d3.finalize");
    const finalReview = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === "d3.final-review");
    assert.ok(finalize, "D3 finalize exists");
    assert.ok(finalReview, "D3 final review exists");
    if (finalReview && finalReview.kind === "delegate") {
      assert.ok(finalReview.from.includes("final-review-ready"));
    }
  });

  it("has child-local nested transitions", () => {
    const childTransitions = PHENIX_DEFAULT_WORKFLOW.transitions.filter(
      (t) => t.kind === "delegate" && t.scope === "child",
    );
    assert.ok(childTransitions.length > 0, "Has child-local transitions");
    // Planner can request scout
    const plannerScout = childTransitions.find((t) => t.id === "planner.request-scout");
    assert.ok(plannerScout, "Planner can request scout");
  });
});
