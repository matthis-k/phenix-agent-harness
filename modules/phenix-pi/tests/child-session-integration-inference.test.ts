import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inferChildIntegrationRefs } from "@matthis-k/phenix-suite/runtime/child-session-resources.ts";

describe("child integration inference", () => {
  it("does not load Hypa merely for Pi built-in filesystem and shell tools", () => {
    assert.deepEqual(inferChildIntegrationRefs(["read", "bash", "grep", "find", "ls"], []), []);
  });

  it("loads Hypa for explicit hypa tools or an explicit extension ref", () => {
    assert.deepEqual(inferChildIntegrationRefs(["hypa_read"], []), ["hypa"]);
    assert.deepEqual(inferChildIntegrationRefs(["read"], ["hypa"]), ["hypa"]);
  });

  it("continues to infer compact child integrations", () => {
    assert.deepEqual(
      inferChildIntegrationRefs(
        ["lsp", "mcp", "context_info", "web_search", "fetch_content"],
        [],
      ),
      ["context", "lsp", "mcp", "web"],
    );
  });
});
