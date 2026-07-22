import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PHENIX_GENERAL_WORKFLOW } from "../packages/phenix-suite/defaults/workflow-presets.ts";

describe("general workflow dynamic escape actions", () => {
  it("keeps ad-hoc delegation typed and bounded", () => {
    const byId = new Map(PHENIX_GENERAL_WORKFLOW.transitions.map((transition) => [transition.id, transition]));
    const base = byId.get("general.request-base");
    const planner = byId.get("general.request-planner");
    const finalizer = byId.get("general.request-finalizer");

    assert.equal(base?.kind, "delegate");
    assert.equal(planner?.kind, "delegate");
    assert.equal(finalizer?.kind, "delegate");
    if (base?.kind !== "delegate" || planner?.kind !== "delegate" || finalizer?.kind !== "delegate") {
      return;
    }
    assert.equal(base.category, "optional");
    assert.equal(base.maxExecutions, 2);
    assert.equal(base.outputContract.id, "base-handoff");
    assert.equal(planner.maxExecutions, 1);
    assert.equal(planner.outputContract.id, "planner-handoff");
    assert.equal(finalizer.maxExecutions, 1);
    assert.equal(finalizer.outputContract.id, "finalizer-handoff");
    assert.deepEqual(base.allowedModes, ["await"]);
  });
});
