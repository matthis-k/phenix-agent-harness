import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildSessionSpec } from "../extensions/phenix-runtime/child-session-types.ts";
import { buildEffectiveToolNames } from "../extensions/phenix-runtime/sdk-child-session-backend.ts";
import { normalizeWorkflowRuntimeToolNames } from "../extensions/phenix-runtime/workflow-session-factory.ts";

function spec(input: {
  readonly remainingDepth: number;
  readonly availableRoles: readonly string[];
}): ChildSessionSpec {
  return {
    effectiveTools: [
      "read",
      "phenix_delegate",
      "phenix_workflow",
      "phenix_create_subagent",
      "phenix_complete",
    ],
    contract: {
      runtime: {
        delegation: {
          remainingDepth: input.remainingDepth,
          availableRoles: input.availableRoles,
        },
      },
    },
  } as unknown as ChildSessionSpec;
}

function finalTools(child: ChildSessionSpec): readonly string[] {
  return normalizeWorkflowRuntimeToolNames(buildEffectiveToolNames(child));
}

describe("workflow API session initialization", () => {
  it("always installs workflow and completion", () => {
    const tools = finalTools(spec({ remainingDepth: 0, availableRoles: [] }));

    assert.deepEqual(tools, ["phenix_complete", "phenix_workflow", "read"]);
    assert.equal(tools.includes("phenix_delegate"), false);
    assert.equal(tools.includes("phenix_create_subagent"), false);
  });

  it("uses the same workflow surface when delegation remains available", () => {
    const tools = finalTools(spec({ remainingDepth: 2, availableRoles: ["scout"] }));

    assert.deepEqual(tools, ["phenix_complete", "phenix_workflow", "read"]);
  });

  it("does not depend on the initial projection containing an outgoing edge", () => {
    const child = {
      ...spec({ remainingDepth: 1, availableRoles: ["critic"] }),
      workflowProjection: {
        difficulty: "D1" as const,
        currentState: "reviewing",
        revision: 1,
        optionsDigest: "0".repeat(64),
        options: [],
      },
    } as ChildSessionSpec;

    assert.deepEqual(finalTools(child), ["phenix_complete", "phenix_workflow", "read"]);
  });
});
