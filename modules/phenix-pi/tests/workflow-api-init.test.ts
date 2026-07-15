import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChildSessionSpec } from "../extensions/phenix-runtime/child-session-types.ts";
import { buildEffectiveToolNames } from "../extensions/phenix-runtime/sdk-child-session-backend.ts";

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

describe("workflow API session initialization", () => {
  it("always installs workflow inspection and completion", () => {
    const tools = buildEffectiveToolNames(spec({ remainingDepth: 0, availableRoles: [] }));

    assert.deepEqual(tools, ["phenix_complete", "phenix_workflow", "read"]);
    assert.equal(tools.includes("phenix_delegate"), false);
    assert.equal(tools.includes("phenix_create_subagent"), false);
  });

  it("installs subagent creation from contract delegation settings", () => {
    const tools = buildEffectiveToolNames(spec({ remainingDepth: 2, availableRoles: ["scout"] }));

    assert.deepEqual(tools, [
      "phenix_complete",
      "phenix_create_subagent",
      "phenix_workflow",
      "read",
    ]);
  });

  it("does not depend on the initial workflow projection having an option", () => {
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

    assert.equal(buildEffectiveToolNames(child).includes("phenix_create_subagent"), true);
  });
});
