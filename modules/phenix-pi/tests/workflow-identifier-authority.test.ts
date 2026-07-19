import assert from "node:assert/strict";
import "./support/default-workflow-fixture.ts";
import { describe, it } from "node:test";

import { agentClientRef, contractRef } from "@matthis-k/phenix-kernel/refs.ts";
import {
  actorRoleForAgentClient,
  type DefaultWorkflowDefinitionId,
  mkTransitionId,
  outputSchemaIdForContract,
  roleForAgentClient,
} from "@matthis-k/phenix-flow/workflow-types.ts";

describe("workflow identifier authority", () => {
  it("uses the kernel transition-ID validator", () => {
    assert.equal(mkTransitionId("d1.plan"), "d1.plan");
    assert.throws(() => mkTransitionId("   "), /must be non-empty/);
  });

  it("keeps the built-in workflow identity closed", () => {
    const workflowId: DefaultWorkflowDefinitionId = "phenix-default";
    assert.equal(workflowId, "phenix-default");
  });

  it("validates agent-client projections instead of casting", () => {
    assert.equal(roleForAgentClient(agentClientRef("base")), null);
    assert.equal(roleForAgentClient(agentClientRef("planner")), "planner");
    assert.equal(actorRoleForAgentClient(agentClientRef("coordinator")), "coordinator");

    assert.throws(
      () => roleForAgentClient(agentClientRef("unknown-client")),
      /cannot be used as a child execution role/,
    );
    assert.throws(
      () => actorRoleForAgentClient(agentClientRef("unknown-client")),
      /cannot be used as a workflow actor role/,
    );
  });

  it("validates contract-to-schema projections", () => {
    assert.equal(outputSchemaIdForContract(contractRef("planner-handoff")), "planner-handoff");
    assert.throws(
      () => outputSchemaIdForContract(contractRef("unknown-contract")),
      /no workflow output-schema projection/,
    );
  });
});
