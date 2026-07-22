import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ChildSessionSpec } from "../packages/phenix-suite/runtime/child-session-types.ts";
import { RpcChildSessionBackend } from "../packages/phenix-suite/runtime/assurance-rpc-child-session-backend.ts";

const originalPreference = process.env.PHENIX_CHILD_BACKEND;
afterEach(() => {
  if (originalPreference === undefined) delete process.env.PHENIX_CHILD_BACKEND;
  else process.env.PHENIX_CHILD_BACKEND = originalPreference;
});

function spec(input: {
  readonly remainingDepth: number;
  readonly availableRoles?: readonly string[];
  readonly criticRequired?: boolean;
  readonly isolationRequired?: boolean;
}): ChildSessionSpec {
  return {
    isolationRequired: input.isolationRequired ?? false,
    contract: {
      assignment: {
        task: "Review the result",
        requirements: [],
      },
      runtime: {
        delegation: {
          remainingDepth: input.remainingDepth,
          availableRoles: input.availableRoles ?? [],
        },
      },
      verification: { criticRequired: input.criticRequired ?? false },
    },
  } as unknown as ChildSessionSpec;
}

describe("RpcChildSessionBackend selection", () => {
  it("never accepts a child that can still delegate", () => {
    process.env.PHENIX_CHILD_BACKEND = "rpc";
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(
        spec({
          remainingDepth: 1,
          availableRoles: ["scout"],
          isolationRequired: true,
        }),
      ),
      false,
    );
  });

  it("accepts an explicitly requested leaf worker", () => {
    process.env.PHENIX_CHILD_BACKEND = "rpc";
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(backend.supports(spec({ remainingDepth: 0 })), true);
  });

  it("automatically isolates a leaf with explicit isolation policy", () => {
    delete process.env.PHENIX_CHILD_BACKEND;
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(spec({ remainingDepth: 0, isolationRequired: true })),
      true,
    );
  });

  it("does not infer isolation from critic presence", () => {
    delete process.env.PHENIX_CHILD_BACKEND;
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(
        spec({ remainingDepth: 0, criticRequired: true, isolationRequired: false }),
      ),
      false,
    );
  });

  it("honors an explicit SDK override", () => {
    process.env.PHENIX_CHILD_BACKEND = "sdk";
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(spec({ remainingDepth: 0, isolationRequired: true })),
      false,
    );
  });
});
