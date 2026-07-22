import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  ChildRun,
  ChildSessionSpec,
} from "../packages/phenix-suite/runtime/child-session-types.ts";
import {
  type PiRuntimeAdapter,
  SelectingChildSessionBackend,
} from "../packages/phenix-suite/runtime/runtime-adapter.ts";

function adapter(name: string, supported: boolean, calls: string[]): PiRuntimeAdapter {
  return {
    kind: "sdk",
    supports: () => supported,
    async start(spec: ChildSessionSpec): Promise<ChildRun> {
      calls.push(`${name}:${spec.id}`);
      return {} as ChildRun;
    },
  };
}

describe("SelectingChildSessionBackend", () => {
  it("chooses the first supporting adapter", async () => {
    const calls: string[] = [];
    const backend = new SelectingChildSessionBackend([
      adapter("isolated", false, calls),
      adapter("sdk", true, calls),
    ]);
    await backend.start({ id: "child-1" } as ChildSessionSpec, new AbortController().signal);
    assert.deepEqual(calls, ["sdk:child-1"]);
  });
});
