import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerHypaReadRedirect from "../extensions/hypa-read-redirect.ts";
import { ensureReadActive, hasHypaReadTool } from "../extensions/hypa-read-policy.ts";

describe("Hypa read redirect", () => {
  it("defers runtime tool inspection until session startup", () => {
    const handlers = new Map<string, () => void>();
    let getAllToolsCalls = 0;
    let registerToolCalls = 0;

    const pi = {
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      getAllTools() {
        getAllToolsCalls += 1;
        return [{ name: "hypa_read" }];
      },
      registerTool() {
        registerToolCalls += 1;
      },
    } as unknown as ExtensionAPI;

    registerHypaReadRedirect(pi);

    assert.equal(getAllToolsCalls, 0);
    assert.equal(registerToolCalls, 0);

    handlers.get("session_start")?.();
    handlers.get("session_start")?.();

    assert.equal(getAllToolsCalls, 1);
    assert.equal(registerToolCalls, 1);
  });

  it("detects the Hypa reader before overriding read", () => {
    assert.equal(hasHypaReadTool([{ name: "read" }, { name: "hypa_read" }]), true);
    assert.equal(hasHypaReadTool([{ name: "read" }]), false);
  });

  it("restores read after Hypa replace mode filters it", () => {
    assert.deepEqual(ensureReadActive(["hypa_read", "hypa_grep"]), [
      "hypa_read",
      "hypa_grep",
      "read",
    ]);
  });

  it("does not duplicate an already-active read tool", () => {
    assert.deepEqual(ensureReadActive(["hypa_read", "read"]), ["hypa_read", "read"]);
  });
});
