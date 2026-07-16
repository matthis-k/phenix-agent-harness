import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertUniqueWorkflowAgentNames,
  workflowAgentName,
} from "../extensions/phenix-workflow/workflow-action-names.ts";

describe("workflow delegation action names", () => {
  it("defaults to the destination role", () => {
    assert.equal(
      workflowAgentName({ transitionId: "planner.request-scout", role: "scout" }),
      "scout",
    );
  });

  it("gives parallel D3 scouts distinct local names", () => {
    assert.deepEqual(
      [
        "d3.scout-repository",
        "d3.scout-tests",
        "d3.scout-constraints",
      ].map((transitionId) => workflowAgentName({ transitionId, role: "scout" })),
      ["repository-scout", "test-scout", "constraint-scout"],
    );
  });

  it("fails closed on ambiguous names in one actor projection", () => {
    assert.throws(
      () =>
        assertUniqueWorkflowAgentNames([
          { agent: "scout", transitionId: "one" },
          { agent: "scout", transitionId: "two" },
        ]),
      /Ambiguous workflow agent name/,
    );
  });
});
