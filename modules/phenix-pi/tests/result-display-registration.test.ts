import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  readonly pi?: { readonly extensions?: readonly string[] };
};

test("workspace and native display extensions load after the root extension", () => {
  assert.deepEqual(packageJson.pi?.extensions, [
    "./extension/root-extension.ts",
    "./extension/default-workspace-extension.ts",
    "./extension/result-display.ts",
    "./extension/visualization-display.ts",
  ]);
});
