import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  ensureArtifactDir,
  writeJsonArtifact,
  writeRawArtifact,
  writeTextArtifact,
} from "../skills/phenix-qa/runtime/artifacts.ts";

describe("QA artifact persistence", () => {
  it("creates nested absolute directories for every writer", (t) => {
    const root = mkdtempSync(join(tmpdir(), "phenix-qa-artifacts-"));
    const artifactDirectory = join(root, "nested", "artifacts");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    assert.equal(ensureArtifactDir(artifactDirectory), resolve(artifactDirectory));

    const rawPath = writeRawArtifact(artifactDirectory, "metrics", "raw output", "txt");
    const jsonPath = writeJsonArtifact(artifactDirectory, "report", { ok: true });
    const textPath = writeTextArtifact(artifactDirectory, "summary", "complete");

    assert.equal(dirname(rawPath), resolve(artifactDirectory));
    assert.equal(dirname(jsonPath), resolve(artifactDirectory));
    assert.equal(dirname(textPath), resolve(artifactDirectory));
    assert.equal(readFileSync(rawPath, "utf-8"), "raw output");
    assert.equal(readFileSync(jsonPath, "utf-8"), '{\n  "ok": true\n}');
    assert.equal(readFileSync(textPath, "utf-8"), "complete");
    assert.equal(existsSync(artifactDirectory), true);
  });
});
