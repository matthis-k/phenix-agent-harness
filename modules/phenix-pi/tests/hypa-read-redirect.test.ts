import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDeferredHypaReadRegistration,
  ensureReadActive,
  hasHypaReadTool,
} from "../extensions/hypa-read-policy.ts";

describe("Hypa read redirect", () => {
  it("defers runtime tool inspection until session startup", () => {
    let getAllToolsCalls = 0;
    let registerToolCalls = 0;

    const registerAtSessionStart = createDeferredHypaReadRegistration(
      () => {
        getAllToolsCalls += 1;
        return [{ name: "hypa_read" }];
      },
      () => {
        registerToolCalls += 1;
      },
    );

    assert.equal(getAllToolsCalls, 0);
    assert.equal(registerToolCalls, 0);

    registerAtSessionStart();
    registerAtSessionStart();

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
