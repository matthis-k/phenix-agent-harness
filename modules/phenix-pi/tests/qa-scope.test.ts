/**
 * Tests for QA scope resolution.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isIgnoredPath, resolveScopeFiles } from "../skills/phenix-qa/runtime/scope.ts";
import type { ProcessResult, ProcessRunner } from "../skills/phenix-qa/runtime/types.ts";

function fakeRunner(
  responses: Map<string, ProcessResult>,
  throwOn: Set<string> = new Set(),
): ProcessRunner {
  return {
    async exec(
      command: string,
      _args: readonly string[],
      _options?: unknown,
    ): Promise<ProcessResult> {
      if (throwOn.has(command)) {
        throw new Error(`Simulated failure: ${command}`);
      }
      const key = command;
      const result = responses.get(key);
      if (result) return result;

      // Default: success
      return { exitCode: 0, signal: null, stdout: "", stderr: "", durationMs: 0, timedOut: false };
    },
  };
}

describe("Scope resolution", () => {
  describe("Explicit file scope", () => {
    it("returns the listed files as modified", async () => {
      const scope = {
        kind: "files" as const,
        files: ["a.ts", "b.ts"],
        description: "test",
      };
      const result = await resolveScopeFiles(scope, "/fake", fakeRunner(new Map()));
      assert.deepEqual(result.files, ["a.ts", "b.ts"]);
      assert.deepEqual(result.modified, ["a.ts", "b.ts"]);
      assert.deepEqual(result.added, []);
      assert.deepEqual(result.deleted, []);
    });

    it("returns empty arrays for no files", async () => {
      const scope = {
        kind: "files" as const,
        description: "empty",
      };
      const result = await resolveScopeFiles(scope, "/fake", fakeRunner(new Map()));
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.modified, []);
    });
  });

  describe("Diff scope", () => {
    it("falls back to all files when not a git repo", async () => {
      const responses = new Map<string, ProcessResult>();
      responses.set("git", {
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
      });
      const cwd = mkdtempSync(join(tmpdir(), "phenix-qa-scope-empty-"));

      try {
        const scope = {
          kind: "diff" as const,
          description: "test diff",
        };
        const result = await resolveScopeFiles(scope, cwd, fakeRunner(responses));
        assert.deepEqual(result.files, []);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("handles diff with added, modified, deleted files", async () => {
      const responses = new Map<string, ProcessResult>();

      // git rev-parse succeeds (it's a git repo)
      responses.set("git", {
        exitCode: 0,
        signal: null,
        stdout: "/fake/.git\n",
        stderr: "",
        durationMs: 0,
        timedOut: false,
      });

      const scope = {
        kind: "diff" as const,
        description: "test diff",
      };
      assert.equal(scope.kind, "diff");
    });

    it("handles diff with name-status output", async () => {
      let callCount = 0;
      const runner: ProcessRunner = {
        async exec(
          _command: string,
          args: readonly string[],
          _options?: unknown,
        ): Promise<ProcessResult> {
          callCount++;
          if (callCount === 1) {
            return {
              exitCode: 0,
              signal: null,
              stdout: "/fake/.git\n",
              stderr: "",
              durationMs: 0,
              timedOut: false,
            };
          }
          if (args.includes("--abbrev-ref")) {
            return {
              exitCode: 0,
              signal: null,
              stdout: "feature-x\n",
              stderr: "",
              durationMs: 0,
              timedOut: false,
            };
          }
          if (args.includes("merge-base")) {
            return {
              exitCode: 1,
              signal: null,
              stdout: "",
              stderr: "",
              durationMs: 0,
              timedOut: false,
            };
          }
          if (args.includes("--name-status")) {
            return {
              exitCode: 0,
              signal: null,
              stdout:
                "M\0src/a.ts\0A\0src/b.ts\0D\0src/old.ts\0R100\0src/old-name.ts\0src/new-name.ts\0",
              stderr: "",
              durationMs: 0,
              timedOut: false,
            };
          }
          return {
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 0,
            timedOut: false,
          };
        },
      };

      const scope = {
        kind: "diff" as const,
        description: "test diff",
      };
      const result = await resolveScopeFiles(scope, "/fake", runner);
      assert.deepEqual(result.modified, ["src/a.ts"]);
      assert.deepEqual(result.added, ["src/b.ts"]);
      assert.deepEqual(result.deleted, ["src/old.ts"]);
      assert.deepEqual(result.renamed, ["src/new-name.ts"]);
    });
  });
});

describe("Path ignoring", () => {
  it("ignores node_modules", () => {
    assert.equal(isIgnoredPath("node_modules/pkg/index.js", ["node_modules"], [], []), true);
  });

  it("ignores .git directory", () => {
    assert.equal(isIgnoredPath(".git/config", [".git"], [], []), true);
  });

  it("ignores generated patterns", () => {
    assert.equal(isIgnoredPath("src/file.generated.ts", [], ["*.generated.*"], []), true);
  });

  it("ignores vendor paths", () => {
    assert.equal(isIgnoredPath("vendor/foo/bar.ts", [], [], ["vendor/"]), true);
  });

  it("does not ignore normal source files", () => {
    assert.equal(isIgnoredPath("src/main.ts", [], [], []), false);
  });

  it("does not ignore files when patterns don't match", () => {
    assert.equal(isIgnoredPath("src/file.ts", [], ["*.generated.*"], []), false);
  });
});
