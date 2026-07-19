import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { discoverGuidance, findProjectRoot } from "../skills/phenix-qa/runtime/guidance.ts";

describe("QA repository guidance", () => {
  it("discovers project-native commands and guidance", (t) => {
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
    writeFileSync(join(root, "DEVELOPMENT.md"), "# Development\n");

    const guidance = discoverGuidance(nested);

    assert.equal(findProjectRoot(nested), root);
    assert.equal(guidance.projectRoot, root);
    assert.deepEqual(guidance.packageManagers, ["npm"]);
    assert.deepEqual(guidance.buildCommands, ["npm run build"]);
    assert.deepEqual(guidance.testCommands, ["npm run test"]);
    assert.deepEqual(guidance.lintCommands, ["npm run lint"]);
    assert.deepEqual(guidance.formatCheckCommands, ["npm run format"]);
    assert.ok(guidance.guidanceDocs.includes(join(root, "DEVELOPMENT.md")));
  });
});
