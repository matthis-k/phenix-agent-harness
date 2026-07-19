import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const phenixRoot = path.resolve(testDirectory, "..");
const packageNames = [
  "phenix-kernel",
  "phenix-flow",
  "phenix-routing",
  "phenix-contracts",
  "phenix-suite",
] as const;

function resolve(relativePath: string): string {
  return path.join(phenixRoot, relativePath);
}

function read(relativePath: string): string {
  return fs.readFileSync(resolve(relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(read(relativePath)) as Record<string, unknown>;
}

describe("Phenix package facades", () => {
  it("keeps Pi registration in explicit extension entrypoints", () => {
    const rootPackage = readJson("package.json") as {
      pi: { extensions: readonly string[] };
    };
    assert.deepEqual(
      rootPackage.pi.extensions.filter((entry) => entry.includes("phenix-suite")),
      ["./packages/phenix-suite/extension.ts"],
    );

    for (const packageName of packageNames) {
      const packageJson = readJson(`packages/${packageName}/package.json`) as {
        pi: { extensions: readonly string[] };
      };
      assert.deepEqual(packageJson.pi.extensions, ["./extension.ts"], packageName);
      assert.equal(fs.existsSync(resolve(`packages/${packageName}/extension.ts`)), true, packageName);
    }
  });

  it("keeps public package facades separate from Pi implementations", () => {
    for (const packageName of packageNames) {
      const facade = read(`packages/${packageName}/index.ts`);
      const implementation = read(`packages/${packageName}/extension.ts`);
      assert.notEqual(facade, implementation, packageName);
      assert.equal(facade.includes("@earendil-works/pi-"), false, packageName);
      assert.equal(facade.includes("function phenix"), false, packageName);
      assert.equal(facade.includes("pi.on("), false, packageName);
      assert.equal(facade.includes("pi.register"), false, packageName);
    }
  });

  it("contains no legacy Phenix extension compatibility tree", () => {
    const legacyEntries = fs
      .readdirSync(resolve("extensions"))
      .filter((entry) => entry.startsWith("phenix-"));
    assert.deepEqual(legacyEntries, []);
  });
});
