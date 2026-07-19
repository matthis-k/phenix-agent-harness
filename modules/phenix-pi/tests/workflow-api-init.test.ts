import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildSessionSpec } from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import { buildEffectiveToolNames } from "@matthis-k/phenix-suite/runtime/sdk-child-session-backend.ts";
import { normalizeWorkflowRuntimeToolNames } from "@matthis-k/phenix-suite/runtime/workflow-session-factory.ts";

function spec(): ChildSessionSpec {
  return {
    effectiveTools: [
      "read",
      "subagent",
      "phenix_workflow",
      "phenix_complete",
      "phenix_tasks",
    ],
  } as unknown as ChildSessionSpec;
}

describe("workflow API session initialization", () => {
  it("installs only the current runtime capabilities", () => {
    const tools = normalizeWorkflowRuntimeToolNames(buildEffectiveToolNames(spec()));

    assert.deepEqual(tools, ["phenix_complete", "phenix_tasks", "phenix_workflow", "read"]);
    assert.equal(tools.includes("subagent"), false);
  });
});
