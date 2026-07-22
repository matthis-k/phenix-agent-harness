import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { review, runQaCli } from "../skills/phenix-qa/runtime/index.ts";

function repository(config: unknown): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "phenix-qa-cli-"));
  writeFileSync(path.join(cwd, ".phenix-qa.json"), JSON.stringify(config), "utf-8");
  writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n", "utf-8");
  return cwd;
}

describe("QA runtime CLI", () => {
  it("runs a review and writes report artifacts", async () => {
    const cwd = repository({
      enabledAnalyzers: [],
      requiredAnalyzers: [],
      output: { writeJson: true, writeText: true },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runQaCli(
        ["review", "--scope", "repository", "--cwd", cwd, "--output", "qa-results"],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      );

      assert.equal(exitCode, 0, stderr.join("\n"));
      assert.ok(stdout.some((line) => line === "QA REVIEW"));
      assert.equal(existsSync(path.join(cwd, "qa-results", "qa-report.json")), true);
      assert.equal(existsSync(path.join(cwd, "qa-results", "qa-report.txt")), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects repository-configured artifact paths outside cwd", async () => {
    const cwd = repository({
      enabledAnalyzers: [],
      requiredAnalyzers: [],
      output: { artifactDirectory: "../escape" },
    });
    try {
      await assert.rejects(
        review({ scope: { kind: "repository", description: "escape test" }, cwd }),
        /artifact directory escapes the reviewed repository/i,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("produces FAIL and CLI exit 1 for a failing project-native command", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "phenix-qa-cli-fail-"));
    writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "exit 1" } }),
      "utf-8",
    );
    writeFileSync(
      path.join(cwd, ".phenix-qa.json"),
      JSON.stringify({
        enabledAnalyzers: ["project-native"],
        requiredAnalyzers: [],
      }),
      "utf-8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runQaCli(
        ["review", "--scope", "repository", "--cwd", cwd, "--trust-repository"],
        {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
      );

      assert.equal(exitCode, 1, `expected FAIL exit code, got: ${exitCode}\n${stderr.join("\n")}`);
      assert.ok(stdout.some((line) => line === "QA FAIL"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("produces FAIL when a required analyzer is unavailable", async () => {
    const cwd = repository({
      enabledAnalyzers: [],
      requiredAnalyzers: ["project-native"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runQaCli(["review", "--scope", "repository", "--cwd", cwd], {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      });

      assert.equal(exitCode, 1, `expected FAIL exit code, got: ${exitCode}\n${stderr.join("\n")}`);
      assert.ok(stdout.some((line) => line === "QA FAIL"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("requires an explicit flag for caller-owned external output", async () => {
    const cwd = repository({ enabledAnalyzers: [], requiredAnalyzers: [] });
    const externalRoot = mkdtempSync(path.join(os.tmpdir(), "phenix-qa-external-"));
    const outputDirectory = path.join(externalRoot, "results");
    try {
      await assert.rejects(
        review({
          scope: { kind: "repository", description: "external output" },
          cwd,
          outputDirectory,
        }),
        /artifact directory escapes the reviewed repository/i,
      );

      const result = await review({
        scope: { kind: "repository", description: "external output" },
        cwd,
        outputDirectory,
        allowExternalOutput: true,
      });
      assert.ok(
        result.artifacts.some(
          (artifact) => artifact === path.join(outputDirectory, "qa-report.json"),
        ),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});
