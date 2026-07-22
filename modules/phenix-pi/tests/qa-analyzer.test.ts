/**
 * Tests for QA analyzers — adapter contracts, availability, and error handling.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DUPLICATION_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/duplication.ts";
import { GIT_HISTORY_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/git-history.ts";
import { METRICS_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/metrics.ts";
import { ALL_ANALYZERS } from "../skills/phenix-qa/runtime/analyzers/registry.ts";
import { SECURITY_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/security.ts";
import { STRUCTURAL_ANALYZER } from "../skills/phenix-qa/runtime/analyzers/structural.ts";
import { DEFAULT_QA_CONFIG } from "../skills/phenix-qa/runtime/config.ts";
import type { QaAnalyzerContext } from "../skills/phenix-qa/runtime/types.ts";

function makeContext(overrides: Partial<QaAnalyzerContext> = {}): QaAnalyzerContext {
  const dir = mkdtempSync(join(tmpdir(), "qa-test-"));
  return {
    cwd: process.cwd(),
    scope: { kind: "repository", description: "test" },
    scopedFiles: [],
    artifactDirectory: dir,
    config: DEFAULT_QA_CONFIG,
    ...overrides,
  };
}

describe("QA Analyzers", () => {
  describe("Registry", () => {
    it("all analyzers have id and categories", () => {
      for (const analyzer of ALL_ANALYZERS) {
        assert.ok(analyzer.id, `analyzer ${analyzer.constructor.name} missing id`);
        assert.ok(analyzer.categories.length > 0, `analyzer ${analyzer.id} has no categories`);
        assert.equal(typeof analyzer.checkAvailability, "function");
        assert.equal(typeof analyzer.run, "function");
      }
    });

    it("all analyzer IDs are unique", () => {
      const ids = ALL_ANALYZERS.map((a) => a.id);
      assert.equal(ids.length, new Set(ids).size);
    });
  });

  describe("Git history analyzer", () => {
    it("reports not-applicable when not in a git repo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-git-test-"));

      const ctx = makeContext({ cwd: dir });
      const result = await GIT_HISTORY_ANALYZER.run(ctx);
      assert.ok(result.status === "not-applicable" || result.status === "unavailable");
    });

    it("reports availability accurately", async () => {
      const ctx = makeContext();
      const av = await GIT_HISTORY_ANALYZER.checkAvailability(ctx);
      assert.equal(typeof av.available, "boolean");
      if (av.available) {
        assert.equal(av.executable, "git");
      } else {
        assert.ok(av.reason);
      }
    });
  });

  describe("Structural analyzer", () => {
    it("completes bundled rules even when no repository rules exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-struct-test-"));

      const ctx = makeContext({
        cwd: dir,
        config: { ...DEFAULT_QA_CONFIG, structuralRuleDirectories: [] },
      });
      const result = await STRUCTURAL_ANALYZER.run(ctx);
      assert.equal(result.status, "completed");
      assert.ok(
        result.diagnostics.some((d) => d.includes("ast-grep scan completed")),
        "expected bundled rules to execute",
      );
    });

    it("discovers and executes bundled rules in the real repository", async () => {
      const ctx = makeContext();
      const result = await STRUCTURAL_ANALYZER.run(ctx);
      assert.equal(result.status, "completed");
      assert.ok(
        result.diagnostics.some((d) => d.includes("ast-grep scan completed")),
        "expected ast-grep to execute bundled rules",
      );
    });
  });

  describe("Metrics analyzer", () => {
    it("reports a valid packaged FTA availability shape", async () => {
      const ctx = makeContext();
      const av = await METRICS_ANALYZER.checkAvailability(ctx);
      assert.equal(typeof av.available, "boolean");
      if (av.available) {
        assert.equal(av.version, "3.0.0");
        assert.ok(av.executable);
      } else {
        assert.ok(av.reason);
      }
    });
  });

  describe("Duplication analyzer", () => {
    it("reports unavailable when jscpd is not installed", async () => {
      const ctx = makeContext();
      const av = await DUPLICATION_ANALYZER.checkAvailability(ctx);
      assert.equal(typeof av.available, "boolean");
      if (!av.available) {
        assert.ok(av.reason);
      }
    });
  });

  describe("Security analyzer", () => {
    it("reports unavailable when semgrep is not installed", async () => {
      const ctx = makeContext();
      const av = await SECURITY_ANALYZER.checkAvailability(ctx);
      assert.equal(typeof av.available, "boolean");
      if (!av.available) {
        assert.ok(av.reason);
      }
    });
  });
});

describe("Structural analyzer failures", () => {
  it("fails closed when a configured ast-grep rules directory is invalid", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qa-struct-invalid-"));
    const rules = join(cwd, "rules");
    mkdirSync(rules);
    writeFileSync(join(rules, "sgconfig.yml"), "rules: [\n", "utf-8");

    const result = await STRUCTURAL_ANALYZER.run(
      makeContext({
        cwd,
        config: {
          ...DEFAULT_QA_CONFIG,
          structuralRuleDirectories: ["rules"],
        },
      }),
    );

    assert.equal(result.status, "failed");
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("ast-grep")));
  });
});
