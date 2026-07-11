import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rolePreset } from "../extensions/phenix-subagents/role-presets.ts";
import type { AgentKind } from "../extensions/phenix-subagents/policy.ts";

describe("Role presets", () => {
  it("scout has read-only tools", () => {
    const preset = rolePreset("scout");
    assert.ok(preset.tools.includes("read"));
    assert.ok(preset.tools.includes("grep"));
    assert.ok(!preset.tools.includes("write"));
    assert.ok(!preset.tools.includes("edit"));
  });

  it("implementer has write tools", () => {
    const preset = rolePreset("implementer");
    assert.ok(preset.tools.includes("read"));
    assert.ok(preset.tools.includes("write"));
    assert.ok(preset.tools.includes("edit"));
    assert.ok(preset.tools.includes("apply_patch"));
  });

  it("all roles have agentName starting with phenix.", () => {
    const roles: AgentKind[] = [
      "scout", "planner", "architect", "implementer",
      "tester", "critic", "finalizer",
    ];
    for (const role of roles) {
      const preset = rolePreset(role);
      assert.ok(preset.agentName.startsWith("phenix."));
      assert.equal(preset.agentName, `phenix.${role}`);
    }
  });

  it("null role returns empty preset", () => {
    const preset = rolePreset(null);
    assert.equal(preset.agentName, "phenix.base");
    assert.equal(preset.tools.length, 0);
    assert.equal(preset.allowedChildren.length, 0);
    assert.equal(preset.criticRequired, false);
  });

  it("all presets have thinking levels for all tiers", () => {
    const roles: AgentKind[] = [
      "scout", "planner", "architect", "implementer",
      "tester", "critic", "finalizer",
    ];
    for (const role of roles) {
      const preset = rolePreset(role);
      assert.ok("low" in preset.thinking);
      assert.ok("standard" in preset.thinking);
      assert.ok("high" in preset.thinking);
      assert.ok("critical" in preset.thinking);
    }
  });

  it("empty preset has thinking levels for all tiers", () => {
    const preset = rolePreset(null);
    assert.ok("low" in preset.thinking);
    assert.ok("standard" in preset.thinking);
    assert.ok("high" in preset.thinking);
    assert.ok("critical" in preset.thinking);
  });

  it("scout allowed children", () => {
    const preset = rolePreset("scout");
    assert.deepEqual(preset.allowedChildren, ["scout"]);
  });

  it("planner allowed children", () => {
    const preset = rolePreset("planner");
    assert.ok(preset.allowedChildren.includes("scout"));
    assert.ok(preset.allowedChildren.includes("architect"));
    assert.ok(preset.allowedChildren.includes("critic"));
  });

  it("implementer allowed children", () => {
    const preset = rolePreset("implementer");
    assert.ok(preset.allowedChildren.includes("scout"));
    assert.ok(preset.allowedChildren.includes("tester"));
    assert.ok(preset.allowedChildren.includes("critic"));
  });

  it("critic required for planner, architect, implementer", () => {
    assert.equal(rolePreset("planner").criticRequired, true);
    assert.equal(rolePreset("architect").criticRequired, true);
    assert.equal(rolePreset("implementer").criticRequired, true);
  });

  it("critic not required for scout, tester, critic, finalizer", () => {
    assert.equal(rolePreset("scout").criticRequired, false);
    assert.equal(rolePreset("tester").criticRequired, false);
    assert.equal(rolePreset("critic").criticRequired, false);
    assert.equal(rolePreset("finalizer").criticRequired, false);
  });

  it("common read tools do not include old contract tools", () => {
    const preset = rolePreset("scout");
    assert.ok(!preset.tools.includes("phenix_contract_get"));
    assert.ok(!preset.tools.includes("phenix_contract_submit"));
  });

  it("common read tools do not include phenix_complete", () => {
    const preset = rolePreset("scout");
    assert.ok(!preset.tools.includes("phenix_complete"));
  });
});
