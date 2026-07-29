import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  readonly pi?: { readonly extensions?: readonly string[] };
};

test("theme, runtime, workspace, and display extensions load in dependency order", () => {
  assert.deepEqual(packageJson.pi?.extensions, [
    "./extension/theme-extension.ts",
    "./extension/root-extension.ts",
    "./extension/default-workspace-extension.ts",
    "./extension/result-display.ts",
    "./extension/visualization-display.ts",
  ]);
});
