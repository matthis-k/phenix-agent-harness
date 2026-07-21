import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentKind } from "@matthis-k/phenix-suite/subagents/policy.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

const QA_SPECIALISTS = ["scout", "tester", "architect", "critic"] as const;

describe("Role presets", () => {
  it("scout and base have read-only tools", () => {
    for (const role of ["scout", null] as const) {
      const preset = rolePreset(role);
      assert.ok(preset.tools.includes("read"));
      assert.ok(preset.tools.includes("grep"));
      assert.ok(preset.tools.includes("bash"));
      assert.ok(!preset.tools.includes("write"));
      assert.ok(!preset.tools.includes("edit"));
    }
  });

  it("implementer has write tools", () => {
    const preset = rolePreset("implementer");
    assert.ok(preset.tools.includes("read"));
    assert.ok(preset.tools.includes("write"));
    assert.ok(preset.tools.includes("edit"));
    assert.ok(preset.tools.includes("apply_patch"));
  });

  it("all named roles have matching phenix agent names", () => {
    const roles: AgentKind[] = [
      "scout",
      "planner",
      "architect",
      "implementer",
      "tester",
      "critic",
      "finalizer",
    ];
    for (const role of roles) {
      const preset = rolePreset(role);
      assert.equal(preset.agentName, `phenix.${role}`);
    }
  });

  it("null role returns a read-capable base integrator preset", () => {
    const preset = rolePreset(null);
    assert.equal(preset.agentName, "phenix.base");
    assert.ok(preset.tools.includes("read"));
    assert.ok(preset.tools.includes("bash"));
    assert.ok(!preset.tools.includes("write"));
    assert.deepEqual(preset.allowedChildren, QA_SPECIALISTS);
    assert.equal(preset.criticRequired, false);
  });

  it("all presets have thinking levels for all tiers", () => {
    const roles: Array<AgentKind | null> = [
      null,
      "scout",
      "planner",
      "architect",
      "implementer",
      "tester",
      "critic",
      "finalizer",
    ];
    for (const role of roles) {
      const preset = rolePreset(role);
      assert.ok("low" in preset.thinking);
      assert.ok("standard" in preset.thinking);
      assert.ok("high" in preset.thinking);
      assert.ok("critical" in preset.thinking);
    }
  });

  it("preserves role-specific child authority", () => {
    assert.deepEqual(rolePreset(null).allowedChildren, QA_SPECIALISTS);
    assert.deepEqual(rolePreset("scout").allowedChildren, ["scout"]);

    const planner = rolePreset("planner").allowedChildren;
    assert.ok(planner.includes("scout"));
    assert.ok(planner.includes("architect"));
    assert.ok(planner.includes("critic"));

    const implementer = rolePreset("implementer").allowedChildren;
    assert.ok(implementer.includes("scout"));
    assert.ok(implementer.includes("tester"));
    assert.ok(implementer.includes("critic"));
  });

  it("requires critics only for planning, architecture, and implementation", () => {
    assert.equal(rolePreset("planner").criticRequired, true);
    assert.equal(rolePreset("architect").criticRequired, true);
    assert.equal(rolePreset("implementer").criticRequired, true);

    assert.equal(rolePreset(null).criticRequired, false);
    assert.equal(rolePreset("scout").criticRequired, false);
    assert.equal(rolePreset("tester").criticRequired, false);
    assert.equal(rolePreset("critic").criticRequired, false);
    assert.equal(rolePreset("finalizer").criticRequired, false);
  });

  it("task presets do not include runtime-owned completion", () => {
    assert.ok(!rolePreset(null).tools.includes("phenix_complete"));
    assert.ok(!rolePreset("scout").tools.includes("phenix_complete"));
  });
});
