import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveToolConfiguration,
  toolAllowedByConfig,
  modelTaskTools,
  childLaunchTools,
  EMPTY_TOOL_PATCH,
  type ToolPatchInput,
} from "../extensions/phenix-subagents/tool-policy.ts";
import type { AgentRole } from "../extensions/phenix-subagents/agent-types.ts";

describe("Tool-policy resolution", () => {
  it("scout preset without patch", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    assert.equal(config.role, "scout");
    assert.equal(config.source.inherited, true);
    assert.deepEqual(config.source.patch, EMPTY_TOOL_PATCH);
    // Scout effective tools should include read-only tools.
    assert.ok(config.effective.includes("read"));
    assert.ok(config.effective.includes("grep"));
    assert.ok(config.effective.includes("ls"));
  });

  it("scout plus write", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"] },
    });
    assert.ok(config.effective.includes("read"));
    assert.ok(config.effective.includes("write"));
    assert.equal(config.effective.filter((t) => t === "write").length, 1);
  });

  it("implementer minus write", () => {
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { removed: ["write"] },
    });
    assert.ok(config.effective.includes("read"));
    assert.ok(!config.effective.includes("write"));
    assert.ok(config.effective.includes("edit"));
    assert.ok(config.effective.includes("todo"));
  });

  it("implementer minus both write and edit", () => {
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { removed: ["write", "edit"] },
    });
    assert.ok(!config.effective.includes("write"));
    assert.ok(!config.effective.includes("edit"));
    // Still has read, todo, etc.
    assert.ok(config.effective.includes("read"));
    assert.ok(config.effective.includes("todo"));
  });

  it("same tool in additional and removed: removed wins", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"], removed: ["write"] },
    });
    assert.ok(!config.effective.includes("write"));
  });

  it("duplicate additions are deduplicated", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write", "write"] },
    });
    assert.equal(config.effective.filter((t) => t === "write").length, 1);
  });

  it("preset order remains stable", () => {
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { additional: ["custom_tool"] },
    });
    const readIdx = config.effective.indexOf("read");
    const customIdx = config.effective.indexOf("custom_tool");
    // read should come before custom_tool (preset order preserved, new tools appended).
    assert.ok(readIdx < customIdx);
  });

  it("input arrays are not mutated", () => {
    const additional: string[] = ["write"];
    const removed: string[] = ["edit"];
    const originalAdditional = [...additional];
    const originalRemoved = [...removed];

    resolveToolConfiguration({
      role: "implementer",
      requested: { additional, removed },
    });

    assert.deepEqual(additional, originalAdditional);
    assert.deepEqual(removed, originalRemoved);
  });

  it("role null plus empty patch produces no task tools", () => {
    const config = resolveToolConfiguration({
      role: null,
      requested: { additional: [], removed: [] },
    });
    assert.equal(config.effective.length, 0);
  });

  it("role null plus read produces only read", () => {
    const config = resolveToolConfiguration({
      role: null,
      requested: { additional: ["read"] },
    });
    assert.equal(config.effective.length, 1);
    assert.equal(config.effective[0], "read");
  });

  it("tools null inherits creator patch", () => {
    const inheritedPatch = {
      additional: ["web_search"],
      removed: ["write"],
    };
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: null,
      inheritedPatch,
    });
    assert.equal(config.source.inherited, true);
    assert.ok(config.effective.includes("web_search"));
    assert.ok(!config.effective.includes("write"));
  });

  it("inherited patch is applied to child role preset, not creator effective set", () => {
    // Creator was "implementer" with patch: +web_search -write
    // Child role is "scout" (no write, no edit in preset).
    const inheritedPatch = {
      additional: ["web_search"],
      removed: ["write"],
    };
    const config = resolveToolConfiguration({
      role: "scout",  // Scout preset doesn't have write.
      requested: null,
      inheritedPatch,
    });
    // Scout preset tools + web_search.
    assert.ok(config.effective.includes("web_search"));
    // write removal is a no-op since scout preset doesn't have write.
    assert.ok(config.effective.includes("read"));
  });

  it("tools {} does not inherit", () => {
    // Use a tool NOT in the base preset to verify no inheritance.
    const inheritedPatch = {
      additional: ["custom_tool_only_in_inherited"],
      removed: ["read"],
    };
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { additional: [], removed: [] },
      inheritedPatch,
    });
    assert.equal(config.source.inherited, false);
    // No inherited additions — custom_tool_only_in_inherited should NOT be present.
    assert.ok(!config.effective.includes("custom_tool_only_in_inherited"));
    // No inherited removals — read should still be present (implementer preset has it).
    assert.ok(config.effective.includes("read"));
    assert.ok(config.effective.includes("write")); // implementer preset has write
  });

  it("root tools null resolves to empty patch", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: null,
      // No inheritedPatch passed → should use EMPTY_TOOL_PATCH.
    });
    assert.equal(config.source.inherited, true);
    assert.deepEqual(config.source.patch, EMPTY_TOOL_PATCH);
  });

  it("raw subagent is rejected in additions", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["subagent"] },
      });
    }, /subagent/);
  });

  it("raw subagent is rejected in removals", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { removed: ["subagent"] },
      });
    }, /subagent/);
  });

  it("phenix_contract_get is rejected", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["phenix_contract_get"] },
      });
    }, /phenix_contract_get/);
  });

  it("phenix_contract_submit is rejected", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["phenix_contract_submit"] },
      });
    }, /phenix_contract_submit/);
  });

  it("phenix_complete cannot be manually added", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["phenix_complete"] },
      });
    }, /phenix_complete/);
  });

  it("phenix_complete cannot be manually removed", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { removed: ["phenix_complete"] },
      });
    }, /phenix_complete/);
  });

  it("unknown tool additions are rejected", () => {
    // Invalid characters in tool name.
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["invalid tool!"] },
      });
    }, /Invalid tool name/);
  });

  it("empty tool name is rejected", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: [""] },
      });
    }, /Invalid tool name/);
  });

  it("delegation ceiling rejects unauthorized additions", () => {
    assert.throws(() => {
      resolveToolConfiguration({
        role: "scout",
        requested: { additional: ["write"] },
        delegableTools: ["read", "grep"],
      });
    }, /not authorized for delegation/);
  });

  it("delegation ceiling allows authorized additions", () => {
    // With full-effective-set ceiling validation, the delegable set
    // must cover all preset tools plus the addition.
    const broadCeiling = [
      "read", "grep", "search", "find", "ls", "tree",
      "bash", "lsp", "lsp_*", "ast_grep", "ast_*", "mcp",
      "mcp_*", "web_search", "web_fetch", "fetch_content",
      "get_search_content", "context_info", "context_*",
      "contact_supervisor", "phenix_delegate", "write",
    ];
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"] },
      delegableTools: broadCeiling,
    });
    assert.ok(config.effective.includes("write"));
  });
});

describe("Tool authorization", () => {
  it("tool guard uses contract effective tools", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"] },
    });
    assert.ok(toolAllowedByConfig(config, "read"));
    assert.ok(toolAllowedByConfig(config, "write"));
    assert.ok(!toolAllowedByConfig(config, "edit"));
  });

  it("scout plus write may call write", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"] },
    });
    assert.ok(toolAllowedByConfig(config, "write"));
  });

  it("implementer minus write may not call write", () => {
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { removed: ["write"] },
    });
    assert.ok(!toolAllowedByConfig(config, "write"));
    assert.ok(toolAllowedByConfig(config, "edit"));
  });

  it("role null with no task tools may only use phenix_complete", () => {
    const config = resolveToolConfiguration({
      role: null,
      requested: { additional: [], removed: [] },
    });
    // No task tools, but phenix_complete is always allowed.
    assert.ok(!toolAllowedByConfig(config, "read"));
    assert.ok(!toolAllowedByConfig(config, "write"));
    assert.ok(toolAllowedByConfig(config, "phenix_complete"));
  });

  it("raw subagent is always blocked", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    assert.ok(!toolAllowedByConfig(config, "subagent"));
  });

  it("old contract tools are always blocked", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    assert.ok(!toolAllowedByConfig(config, "phenix_contract_get"));
    assert.ok(!toolAllowedByConfig(config, "phenix_contract_submit"));
  });
});

describe("Launch tools", () => {
  it("childLaunchTools includes phenix_complete", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    const launch = childLaunchTools(config);
    assert.ok(launch.includes("phenix_complete"));
    assert.ok(launch.includes("read"));
  });

  it("childLaunchTools does not include old contract tools", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    const launch = childLaunchTools(config);
    assert.ok(!launch.includes("phenix_contract_get"));
    assert.ok(!launch.includes("phenix_contract_submit"));
  });

  it("modelTaskTools does not include phenix_complete", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: undefined,
    });
    const tools = modelTaskTools(config);
    assert.ok(!tools.includes("phenix_complete"));
  });
});
