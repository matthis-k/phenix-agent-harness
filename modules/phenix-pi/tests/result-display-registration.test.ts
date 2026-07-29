import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  readonly pi?: { readonly extensions?: readonly string[] };
};

test("Pi registers one public Phenix extension entrypoint", () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./extension/phenix.ts"]);
});
