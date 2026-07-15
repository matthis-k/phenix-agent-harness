import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensureReadActive, hasHypaReadTool } from "../extensions/hypa-read-policy.ts";

describe("Hypa read redirect", () => {
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
