import assert from "node:assert/strict";
import test from "node:test";

import {
  formatToolAvailabilityIssues,
  inspectToolAvailability,
} from "../adapters/pi-sdk/tool-preflight.ts";
import { agentDefinitions } from "../definitions/agents.ts";

export const TEST_CUSTOM_TOOLS = [
  "phenix_run",
  "phenix_handle",
  "phenix_present",
  "phenix_tasks",
  "phenix_return",
  "phenix_fail",
  "phenix_progress",
].map((name) => ({ name }));

test("all bundled agent tool policies reference registered tools", () => {
  for (const definition of agentDefinitions) {
    const issues = inspectToolAvailability({
      tools: definition.tools.allow,
      customTools: TEST_CUSTOM_TOOLS,
      checkExecutables: false,
    });
    assert.deepEqual(
      issues,
      [],
      `${formatToolAvailabilityIssues(definition.id, issues)}\n${JSON.stringify(issues, null, 2)}`,
    );
  }
});

test("tool preflight distinguishes registration from PATH failures", () => {
  assert.deepEqual(
    inspectToolAvailability({
      tools: ["unknown_tool"],
      customTools: [],
      path: "",
    }),
    [{ tool: "unknown_tool", reason: "not_registered" }],
  );
  assert.deepEqual(
    inspectToolAvailability({
      tools: ["bash", "nix_shell"],
      customTools: [],
      path: "/definitely/not/a/tool/path",
    }),
    [
      {
        tool: "bash",
        reason: "executable_not_found",
        executable: "bash",
        searchedPath: "/definitely/not/a/tool/path",
      },
      {
        tool: "nix_shell",
        reason: "executable_not_found",
        executable: "nix",
        searchedPath: "/definitely/not/a/tool/path",
      },
    ],
  );
});
