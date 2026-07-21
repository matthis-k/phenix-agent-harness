import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { PROJECT_NATIVE_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/project-native.ts";
import { DEFAULT_QA_CONFIG } from "../skills/phenix-qa/runtime/config.ts";
import { discoverGuidance } from "../skills/phenix-qa/runtime/guidance.ts";
import type { QaAnalyzerContext } from "../skills/phenix-qa/runtime/types.ts";

function repository(): string {
  const cwd = mkdirSync(path.join(os.tmpdir(), "phenix-qa-trust-"), { recursive: true });
  writeFileSync(path.join(cwd, "flake.nix"), "{ outputs = _: {}; }\n", "utf-8");
  writeFileSync(path.join(cwd, "maintenance.nix"), "{}\n", "utf-8");
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "echo repository-controlled" } }),
    "utf-8",
  );
  return cwd;
}

function context(cwd: string, trustedRepository: boolean): QaAnalyzerContext {
  return {
    cwd,
    scope: { kind: "repository", description: "trust test" },
    scopedFiles: ["flake.nix", "maintenance.nix", "package.json"],
    artifactDirectory: cwd,
    config: {
      ...DEFAULT_QA_CONFIG,
      execution: { trustedRepository },
    },
  };
}

describe("QA project-native trust boundary", () => {
  it("discovers the canonical devenv maintenance gate", () => {
    const cwd = repository();
    try {
      assert.ok(discoverGuidance(cwd).testCommands.includes("nix develop -c devenv test"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not execute repository commands without explicit trust", async () => {
    const cwd = repository();
    try {
      const availability = await PROJECT_NATIVE_ANALYZER.checkAvailability(context(cwd, false));
      assert.equal(availability.available, false);
      assert.match(availability.reason ?? "", /explicit trustedRepository opt-in/i);

      const result = await PROJECT_NATIVE_ANALYZER.run(context(cwd, false));
      assert.equal(result.status, "unavailable");
      assert.equal(result.artifacts.length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("advertises discovered commands after explicit trust", async () => {
    const cwd = repository();
    try {
      const availability = await PROJECT_NATIVE_ANALYZER.checkAvailability(context(cwd, true));
      assert.equal(availability.available, true);
      assert.equal(availability.executable, "project-native");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
