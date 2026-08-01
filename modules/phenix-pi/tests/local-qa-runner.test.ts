import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileDeterministicCheck,
  ProcessLocalOperationRunner,
} from "../adapters/process/local-operation-runner.ts";

function operationContext(cwd: string, executionId = "test:local-operation") {
  return {
    cwd,
    signal: new AbortController().signal,
    executionId,
  };
}

test("QA runner reports repositories without a discoverable deterministic check", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phenix-qa-"));
  try {
    const runner = new ProcessLocalOperationRunner();
    const result = (await runner.run(
      "local.qa-checks",
      {},
      operationContext(cwd, "test:no-check"),
    )) as readonly { command: string; ok: boolean; summary: string }[];
    assert.equal(result.length, 1);
    assert.equal(result[0]?.ok, false);
    assert.match(result[0]?.summary ?? "", /No deterministic project check/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("QA runner executes structured checks directly without a shell", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const runner = new ProcessLocalOperationRunner(async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: "check passed", stderr: "" };
  });

  const result = (await runner.run(
    "local.qa-checks",
    { checks: [{ kind: "nix-flake-check" }] },
    operationContext(process.cwd(), "test:structured-check"),
  )) as readonly { command: string; ok: boolean; summary: string }[];

  assert.deepEqual(calls, [
    {
      executable: "nix",
      args: ["flake", "check", "--accept-flake-config", "--print-build-logs", "--keep-going"],
    },
  ]);
  assert.equal(result[0]?.ok, true);
  assert.equal(result[0]?.summary, "check passed");
});

test("QA runner uses devenv test as the single canonical repository gate", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phenix-qa-devenv-"));
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  try {
    await writeFile(path.join(cwd, "devenv.nix"), "{}\n", "utf8");
    await writeFile(path.join(cwd, "flake.nix"), "{}\n", "utf8");
    const runner = new ProcessLocalOperationRunner(async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: "passed", stderr: "" };
    });

    await runner.run("local.qa-checks", {}, operationContext(cwd, "test:devenv"));

    assert.deepEqual(calls, [{ executable: "devenv", args: ["test"] }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deterministic checks compile to fixed executable and argv pairs", () => {
  assert.deepEqual(
    compileDeterministicCheck({
      kind: "package-script",
      manager: "pnpm",
      script: "typecheck",
    }),
    {
      display: "pnpm run typecheck --if-present",
      executable: "pnpm",
      args: ["run", "typecheck", "--if-present"],
    },
  );
  assert.deepEqual(compileDeterministicCheck({ kind: "devenv-test" }), {
    display: "devenv test",
    executable: "devenv",
    args: ["test"],
  });
});

test("QA runner rejects command strings, mutating checks, and unknown check kinds", async () => {
  const runner = new ProcessLocalOperationRunner();
  const context = operationContext(process.cwd(), "test:invalid-check");
  await assert.rejects(
    runner.run("local.qa-checks", { commands: ["npm test; rm -rf ."] }, context),
    /structured check objects/,
  );
  await assert.rejects(
    runner.run("local.qa-checks", { checks: [{ kind: "devenv-maintenance-fix" }] }, context),
    /Unknown deterministic QA check kind/,
  );
  await assert.rejects(
    runner.run("local.qa-checks", { checks: [{ kind: "shell-command" }] }, context),
    /Unknown deterministic QA check kind/,
  );
});

test("local noop remains the only identity operation", async () => {
  const runner = new ProcessLocalOperationRunner();
  const input = { value: 42 };
  assert.equal(
    await runner.run("local.noop", input, operationContext(process.cwd(), "test:noop")),
    input,
  );
  assert.equal(runner.has("local.command"), false);
});
