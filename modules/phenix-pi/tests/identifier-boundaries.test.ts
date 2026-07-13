import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  agentClientRef,
  agentKindRef,
  capabilityRef,
  contractRef,
  modelSetRef,
  refEquals,
  workflowRef,
} from "../extensions/phenix-kernel/refs.ts";
import { cycleModelSet, validateModelSet } from "../extensions/phenix-routing/state.ts";

describe("identifier boundaries", () => {
  it("rejects empty symbolic reference identifiers", () => {
    for (const construct of [
      agentClientRef,
      agentKindRef,
      capabilityRef,
      contractRef,
      modelSetRef,
      workflowRef,
    ]) {
      assert.throws(() => construct("   "), /must be non-empty/);
    }
  });

  it("constructs references with canonical kinds", () => {
    assert.deepEqual(agentClientRef("planner"), {
      kind: "agent-client",
      id: "planner",
    });
    assert.deepEqual(contractRef("planner-handoff"), {
      kind: "contract-definition",
      id: "planner-handoff",
    });
    assert.deepEqual(modelSetRef("mixed"), {
      kind: "model-set",
      id: "mixed",
    });
  });

  it("compares references only within the same resource vocabulary", () => {
    assert.equal(refEquals(agentClientRef("planner"), agentClientRef("planner")), true);
    assert.equal(refEquals(agentClientRef("planner"), agentClientRef("critic")), false);
  });

  it("parses model-set input without casting unknown values", () => {
    assert.equal(validateModelSet(" mixed "), "mixed");
    assert.equal(validateModelSet("not-declared"), undefined);
  });

  it("rejects cycling an empty model-set order", () => {
    assert.throws(() => cycleModelSet(modelSetRef("mixed").id, []), /empty model-set order/);
  });
});
