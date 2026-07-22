import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/phenix-suite/authority",
);

function imports(file: string): readonly string[] {
  const source = fs.readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from\s+|import\()\s*["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

describe("execution authority architecture", () => {
  it("keeps the authority core independent from Pi adapters", () => {
    for (const name of ["types.ts", "store.ts", "assurance.ts", "service.ts", "index.ts"]) {
      for (const specifier of imports(path.join(directory, name))) {
        assert.equal(
          specifier.startsWith("@earendil-works/pi-"),
          false,
          `${name} must not import ${specifier}`,
        );
      }
    }
  });
});
