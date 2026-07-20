import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  childLaunchTools,
  EMPTY_TOOL_PATCH,
  modelTaskTools,
  resolveToolConfiguration,
  toolAllowedByConfig,
} from "@matthis-k/phenix-suite/subagents/tool-policy.ts";

const READ_TOOL_CEILING = [
  "read",
  "grep",
  "search",
  "find",
  "ls",
  "tree",
  "bash",
  "lsp",
  "lsp_*",
  "ast_grep",
  "ast_*",
  "mcp",
  "mcp_*",
  "web_search",
  "web_fetch",
  "fetch_content",
  "get_search_content",
  "context_info",
  "context_*",
  "contact_supervisor",
  "phenix_workflow",
] as const;

describe("Tool-policy resolution", () => {
  it("gives scout and base roles the common read-capable preset", () => {
    for (const role of ["scout", null] as const) {
      const config = resolveToolConfiguration({ role, requested: undefined });
      assert.equal(config.role, role);
      assert.equal(config.source.inherited, true);
      assert.deepEqual(config.source.patch, EMPTY_TOOL_PATCH);
      assert.ok(config.effective.includes("read"));
      assert.ok(config.effective.includes("grep"));
      assert.ok(config.effective.includes("bash"));
      assert.ok(!config.effective.includes("write"));
      assert.ok(!config.effective.includes("edit"));
    }
  });

  it("adds and removes tools without duplicating preset entries", () => {
    const scout = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write", "write"], removed: ["grep"] },
    });
    assert.ok(scout.effective.includes("read"));
    assert.ok(!scout.effective.includes("grep"));
    assert.equal(scout.effective.filter((tool) => tool === "write").length, 1);

    const implementer = resolveToolConfiguration({
      role: "implementer",
      requested: { removed: ["write", "edit"] },
    });
    assert.ok(implementer.effective.includes("read"));
    assert.ok(implementer.effective.includes("todo"));
    assert.ok(!implementer.effective.includes("write"));
    assert.ok(!implementer.effective.includes("edit"));
  });

  it("treats removals as authoritative when a tool is also added", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"], removed: ["write"] },
    });
    assert.ok(!config.effective.includes("write"));
  });

  it("preserves preset order and does not mutate caller arrays", () => {
    const additional = ["custom_tool"];
    const removed = ["write"];
    const config = resolveToolConfiguration({
      role: "implementer",
      requested: { additional, removed },
    });

    assert.ok(config.effective.indexOf("read") < config.effective.indexOf("custom_tool"));
    assert.deepEqual(additional, ["custom_tool"]);
    assert.deepEqual(removed, ["write"]);
  });

  it("applies explicit base patches on top of the read-capable preset", () => {
    const config = resolveToolConfiguration({
      role: null,
      requested: { additional: ["custom_tool"], removed: ["bash"] },
    });
    assert.ok(config.effective.includes("read"));
    assert.ok(config.effective.includes("custom_tool"));
    assert.ok(!config.effective.includes("bash"));
  });

  it("inherits creator patches only when tools are omitted or null", () => {
    const inheritedPatch = {
      additional: ["custom_inherited"],
      removed: ["grep"],
    };
    const inherited = resolveToolConfiguration({
      role: "scout",
      requested: null,
      inheritedPatch,
    });
    assert.equal(inherited.source.inherited, true);
    assert.ok(inherited.effective.includes("custom_inherited"));
    assert.ok(!inherited.effective.includes("grep"));

    const explicit = resolveToolConfiguration({
      role: "scout",
      requested: { additional: [], removed: [] },
      inheritedPatch,
    });
    assert.equal(explicit.source.inherited, false);
    assert.ok(!explicit.effective.includes("custom_inherited"));
    assert.ok(explicit.effective.includes("grep"));
  });

  it("rejects runtime-owned and malformed tool names", () => {
    for (const tool of ["subagent", "phenix_complete", "phenix_tasks", "phenix_workflow"]) {
      assert.throws(
        () =>
          resolveToolConfiguration({
            role: "scout",
            requested: { additional: [tool] },
          }),
        new RegExp(tool),
      );
    }
    assert.throws(
      () =>
        resolveToolConfiguration({
          role: "scout",
          requested: { additional: ["invalid tool!"] },
        }),
      /Invalid tool name/,
    );
    assert.throws(
      () => resolveToolConfiguration({ role: "scout", requested: { additional: [""] } }),
      /Invalid tool name/,
    );
  });

  it("enforces the creator delegation ceiling against the full effective set", () => {
    assert.throws(
      () =>
        resolveToolConfiguration({
          role: "scout",
          requested: { additional: ["write"] },
          delegableTools: ["read", "grep"],
        }),
      /not authorized for delegation/,
    );

    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"] },
      delegableTools: [...READ_TOOL_CEILING, "write"],
    });
    assert.ok(config.effective.includes("write"));
  });
});

describe("Tool authorization", () => {
  it("uses contract effective tools and always blocks unmanaged subagents", () => {
    const config = resolveToolConfiguration({
      role: "scout",
      requested: { additional: ["write"], removed: ["grep"] },
    });
    assert.ok(toolAllowedByConfig(config, "read"));
    assert.ok(toolAllowedByConfig(config, "write"));
    assert.ok(!toolAllowedByConfig(config, "grep"));
    assert.ok(!toolAllowedByConfig(config, "subagent"));
    assert.ok(toolAllowedByConfig(config, "phenix_complete"));
  });

  it("allows base agents to inspect repositories but not modify them", () => {
    const config = resolveToolConfiguration({ role: null, requested: undefined });
    assert.ok(toolAllowedByConfig(config, "read"));
    assert.ok(toolAllowedByConfig(config, "bash"));
    assert.ok(!toolAllowedByConfig(config, "write"));
    assert.ok(!toolAllowedByConfig(config, "edit"));
    assert.ok(toolAllowedByConfig(config, "phenix_complete"));
  });
});

describe("Launch tools", () => {
  it("adds runtime-owned child capabilities without exposing them as task tools", () => {
    const config = resolveToolConfiguration({ role: null, requested: undefined });
    const launch = childLaunchTools(config);
    assert.ok(launch.includes("read"));
    assert.ok(launch.includes("phenix_complete"));
    assert.ok(launch.includes("phenix_tasks"));
    assert.ok(launch.includes("phenix_workflow"));

    const taskTools = modelTaskTools(config);
    assert.ok(taskTools.includes("read"));
    assert.ok(!taskTools.includes("phenix_complete"));
  });
});
