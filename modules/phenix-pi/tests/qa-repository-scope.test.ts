import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveScopeFiles } from "../skills/phenix-qa/runtime/scope.ts";
import type { ProcessRunner } from "../skills/phenix-qa/runtime/types.ts";

function runner(files: readonly string[]): ProcessRunner {
  return {
    async exec(command, args) {
      assert.equal(command, "git");
      assert.deepEqual(args, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      return {
        exitCode: 0,
        signal: null,
        stdout: `${files.join("\0")}\0`,
        stderr: "",
        durationMs: 1,
        timedOut: false,
      };
    },
  };
}

describe("repository QA scope", () => {
  it("returns tracked and non-ignored untracked files", async () => {
    const result = await resolveScopeFiles(
      { kind: "repository", description: "repository" },
      "/repo",
      runner(["src/a.ts", "README.md", "src/new.ts"]),
    );

    assert.deepEqual(result.files, ["README.md", "src/a.ts", "src/new.ts"]);
    assert.deepEqual(result.modified, result.files);
  });

  it("limits module scope to the requested repository-relative subtree", async () => {
    const result = await resolveScopeFiles(
      { kind: "module", module: "src/runtime", description: "runtime module" },
      "/repo",
      runner(["src/runtime/a.ts", "src/runtime/nested/b.ts", "src/ui.ts"]),
    );

    assert.deepEqual(result.files, ["src/runtime/a.ts", "src/runtime/nested/b.ts"]);
  });

  it("rejects module paths outside the repository", async () => {
    await assert.rejects(
      resolveScopeFiles(
        { kind: "module", module: "../other", description: "escape" },
        "/repo",
        runner(["src/a.ts"]),
      ),
      /module scope escapes the reviewed repository/i,
    );
  });
});
