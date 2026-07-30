import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isStandardBuiltinCommand,
  parseWorkspaceCommand,
  registerWorkspaceStandardBuiltins,
  STANDARD_BUILTIN_COMMANDS,
} from "../extension/workspace/workspace-standard-builtins.ts";

const EXPECTED_COMMANDS = [
  "settings",
  "model",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
] as const;

test("registers Phenix handlers for every standard Pi command", () => {
  const registered: string[] = [];
  const pi = {
    registerCommand(name: string): void {
      registered.push(name);
    },
  } as unknown as ExtensionAPI;

  registerWorkspaceStandardBuiltins(pi);

  assert.deepEqual(registered, EXPECTED_COMMANDS);
  assert.deepEqual(
    STANDARD_BUILTIN_COMMANDS.map(([name]) => name),
    EXPECTED_COMMANDS,
  );
});

test("parses standard commands and preserves arguments", () => {
  assert.deepEqual(parseWorkspaceCommand("/login openai"), {
    name: "login",
    args: "openai",
  });
  assert.deepEqual(parseWorkspaceCommand("  /compact keep decisions and file paths  "), {
    name: "compact",
    args: "keep decisions and file paths",
  });
  assert.equal(parseWorkspaceCommand("plain input"), undefined);
});

test("recognizes only the standard built-in surface", () => {
  assert.equal(isStandardBuiltinCommand("/settings"), true);
  assert.equal(isStandardBuiltinCommand("/login anthropic"), true);
  assert.equal(isStandardBuiltinCommand("/workspace"), false);
});
