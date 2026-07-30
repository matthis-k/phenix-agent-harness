import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { STANDARD_BUILTIN_COMMANDS } from "../extension/workspace/workspace-standard-builtins.ts";
import { withWorkspaceStandardBuiltins } from "../extension/workspace/workspace-standard-builtin-api.ts";

function testPi() {
  const sent: unknown[] = [];
  const pi = {
    getCommands() {
      return [
        { name: "workspace", description: "Open workspace" },
        { name: "model", description: "Conflicting extension model command" },
      ];
    },
    sendUserMessage(content: unknown): void {
      sent.push(content);
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

test("adds standard built-ins to workspace autocomplete without duplicates", () => {
  const { pi } = testPi();
  const workspacePi = withWorkspaceStandardBuiltins(pi, async () => {});
  const names = workspacePi.getCommands().map((command) => command.name);

  assert.deepEqual(names.slice(0, STANDARD_BUILTIN_COMMANDS.length), [
    ...STANDARD_BUILTIN_COMMANDS.map(([name]) => name),
  ]);
  assert.equal(names.filter((name) => name === "model").length, 1);
  assert.equal(names.includes("workspace"), true);
});

test("routes standard built-ins to the Phenix executor", async () => {
  const { pi, sent } = testPi();
  const executed: string[] = [];
  const workspacePi = withWorkspaceStandardBuiltins(pi, async (commandText) => {
    executed.push(commandText);
  });

  await Promise.resolve(workspacePi.sendUserMessage("/login openai"));

  assert.deepEqual(executed, ["/login openai"]);
  assert.deepEqual(sent, []);
});

test("keeps ordinary input on Pi's message path", () => {
  const { pi, sent } = testPi();
  const workspacePi = withWorkspaceStandardBuiltins(pi, async () => {});

  workspacePi.sendUserMessage("Explain this code");

  assert.deepEqual(sent, ["Explain this code"]);
});
