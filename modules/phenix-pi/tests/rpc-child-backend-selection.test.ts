import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { ChildSessionSpec } from "../packages/phenix-suite/runtime/child-session-types.ts";
import { RpcChildSessionBackend } from "../packages/phenix-suite/runtime/rpc-child-session-backend.ts";

const originalPreference = process.env.PHENIX_CHILD_BACKEND;
afterEach(() => {
  if (originalPreference === undefined) delete process.env.PHENIX_CHILD_BACKEND;
  else process.env.PHENIX_CHILD_BACKEND = originalPreference;
});

function spec(input: {
  readonly remainingDepth: number;
  readonly availableRoles?: readonly string[];
  readonly criticRequired?: boolean;
  readonly task?: string;
}): ChildSessionSpec {
  return {
    contract: {
      assignment: {
        task: input.task ?? "Review the result",
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
      backend.supports(spec({ remainingDepth: 1, availableRoles: ["scout"] })),
      false,
    );
  });

  it("accepts an explicitly requested leaf worker", () => {
    process.env.PHENIX_CHILD_BACKEND = "rpc";
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(backend.supports(spec({ remainingDepth: 0 })), true);
  });

  it("automatically isolates high-assurance leaf work", () => {
    delete process.env.PHENIX_CHILD_BACKEND;
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(spec({ remainingDepth: 0, task: "Review authentication deployment" })),
      true,
    );
  });

  it("honors an explicit SDK override", () => {
    process.env.PHENIX_CHILD_BACKEND = "sdk";
    const backend = new RpcChildSessionBackend({ agentDir: "/tmp/agent" });
    assert.equal(
      backend.supports(spec({ remainingDepth: 0, criticRequired: true })),
      false,
    );
  });
});
