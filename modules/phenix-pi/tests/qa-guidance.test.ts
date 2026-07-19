import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  discoverGuidance,
  findProjectRoot,
} from "../skills/phenix-qa/runtime/guidance.ts";

describe("QA repository guidance", () => {
  it("discovers current project markers and ignores retired Tend commands", (t) => {
    const root = mkdtempSync(join(tmpdir(), "phenix-qa-guidance-"));
    const nested = join(root, "src", "feature");
    mkdirSync(nested, { recursive: true });
    t.after(() => rmSync(root, { recursive: true, force: true }));

    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          build: "tsc",
          test: "node --test",
          lint: "biome lint .",
          format: "biome format .",
        },
      }),
    );
    writeFileSync(join(root, "devenv.nix"), "{}\n");
    writeFileSync(join(root, "devenv.yaml"), "inputs: {}\n");
    writeFileSync(join(root, "DEVELOPMENT.md"), "# Development\n");
    writeFileSync(
      join(root, ".tend.json"),
      JSON.stringify({ commands: { build: ["retired-build"], test: ["retired-test"] } }),
    );

    const guidance = discoverGuidance(nested);

    assert.equal(guidance.projectRoot, root);
    assert.deepEqual(guidance.packageManagers, ["npm", "devenv"]);
    assert.deepEqual(guidance.buildCommands, ["npm run build"]);
    assert.deepEqual(guidance.testCommands, ["npm run test"]);
    assert.deepEqual(guidance.lintCommands, ["npm run lint"]);
    assert.deepEqual(guidance.formatCheckCommands, ["npm run format"]);
    assert.ok(guidance.guidanceDocs.includes(join(root, "DEVELOPMENT.md")));
    assert.ok(!guidance.buildCommands.includes("retired-build"));
    assert.ok(!guidance.testCommands.includes("retired-test"));
  });

  it("does not treat a retired Tend file as a project-root marker", (t) => {
    const root = mkdtempSync(join(tmpdir(), "phenix-qa-retired-root-"));
    const nested = join(root, "src");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".tend.json"), "{}\n");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    assert.equal(findProjectRoot(nested), nested);
  });
});
