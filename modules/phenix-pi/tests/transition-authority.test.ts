import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorityFromCeiling,
  isTransitionPermitted,
  type TransitionAuthority,
} from "../extensions/phenix-workflow/transition-authority.ts";
import type { WorkflowTransitionId } from "../extensions/phenix-workflow/workflow-types.ts";

// Cast helper for tests — WorkflowTransitionId is a branded string.
function t(id: string): WorkflowTransitionId {
  return id as unknown as WorkflowTransitionId;
}

describe("TransitionAuthority", () => {
  it("unrestricted authority permits any transition", () => {
    const auth: TransitionAuthority = { kind: "unrestricted" };
    assert.ok(isTransitionPermitted(t("delegate_to_planner"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_scout"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_implementer"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_architect"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_tester"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_critic"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_finalizer"), auth));
    assert.ok(isTransitionPermitted(t("self_complete"), auth));
  });

  it("restricted authority permits only listed transitions", () => {
    const auth: TransitionAuthority = {
      kind: "restricted",
      allowed: [t("delegate_to_planner"), t("delegate_to_scout")],
    };

    assert.ok(isTransitionPermitted(t("delegate_to_planner"), auth));
    assert.ok(isTransitionPermitted(t("delegate_to_scout"), auth));
    assert.ok(!isTransitionPermitted(t("delegate_to_implementer"), auth));
    assert.ok(!isTransitionPermitted(t("self_complete"), auth));
  });

  it("empty restricted authority denies all", () => {
    const auth: TransitionAuthority = {
      kind: "restricted",
      allowed: [],
    };

    assert.ok(!isTransitionPermitted(t("delegate_to_planner"), auth));
    assert.ok(!isTransitionPermitted(t("delegate_to_scout"), auth));
    assert.ok(!isTransitionPermitted(t("self_complete"), auth));
  });

  it("authorityFromCeiling converts string array to restricted", () => {
    const auth = authorityFromCeiling([t("delegate_to_scout"), t("delegate_to_tester")]);
    assert.equal(auth.kind, "restricted");
    if (auth.kind === "restricted") {
      assert.deepEqual(
        [...auth.allowed].sort(),
        [t("delegate_to_scout"), t("delegate_to_tester")].sort(),
      );
    }
  });

  it("authorityFromCeiling with empty array produces deny-all", () => {
    const auth = authorityFromCeiling([]);
    assert.equal(auth.kind, "restricted");
    if (auth.kind === "restricted") {
      assert.equal(auth.allowed.length, 0);
    }
  });

  it("restricted authority is structurally immutable via isTransitionPermitted", () => {
    const auth: TransitionAuthority = {
      kind: "restricted",
      allowed: Object.freeze([t("delegate_to_planner")]) as readonly WorkflowTransitionId[],
    };

    // Should not throw even with frozen array.
    assert.ok(isTransitionPermitted(t("delegate_to_planner"), auth));
    assert.ok(!isTransitionPermitted(t("delegate_to_scout"), auth));
  });

  it("unrestricted authority round-trips through delegation authority", () => {
    const rootAuth: TransitionAuthority = { kind: "unrestricted" };

    const childAuth: TransitionAuthority = {
      kind: "restricted",
      allowed: [t("delegate_to_scout"), t("delegate_to_tester")],
    };

    const criticAuth: TransitionAuthority = {
      kind: "restricted",
      allowed: [],
    };

    assert.ok(isTransitionPermitted(t("delegate_to_planner"), rootAuth));
    assert.ok(isTransitionPermitted(t("self_complete"), rootAuth));

    assert.ok(!isTransitionPermitted(t("delegate_to_planner"), childAuth));
    assert.ok(isTransitionPermitted(t("delegate_to_scout"), childAuth));

    assert.ok(!isTransitionPermitted(t("delegate_to_tester"), criticAuth));
    assert.ok(!isTransitionPermitted(t("self_complete"), criticAuth));
  });
});
