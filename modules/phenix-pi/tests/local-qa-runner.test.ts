import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcessLocalOperationRunner,
  parseApprovedCheckCommand,
} from "../adapters/process/local-operation-runner.ts";

test("QA runner reports repositories without a discoverable deterministic check", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phenix-qa-"));
  try {
    const runner = new ProcessLocalOperationRunner();
    const result = (await runner.run(
      "local.qa-checks",
      {},
      {
        cwd,
        signal: new AbortController().signal,
      },
    )) as readonly { command: string; ok: boolean; summary: string }[];
    assert.equal(result.length, 1);
    assert.equal(result[0]?.ok, false);
    assert.match(result[0]?.summary ?? "", /No deterministic project check/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("QA runner executes approved checks directly without a shell", async () => {
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const runner = new ProcessLocalOperationRunner(async (executable, args) => {
    calls.push({ executable, args });
    return { stdout: "check passed", stderr: "" };
  });

  const result = (await runner.run(
    "local.qa-checks",
    {
      commands: ["nix flake check --accept-flake-config --print-build-logs --keep-going"],
    },
    {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    },
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

test("approved QA command parsing preserves quoted arguments without shell evaluation", () => {
  assert.deepEqual(parseApprovedCheckCommand('nix flake check ".#package check"'), {
    executable: "nix",
    args: ["flake", "check", ".#package check"],
  });
});

test("QA runner rejects generic shell composition and unapproved commands", async () => {
  const runner = new ProcessLocalOperationRunner();
  const context = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
  };
  await assert.rejects(
    runner.run("local.qa-checks", { commands: ["npm test; rm -rf ."] }, context),
    /may not contain shell composition/,
  );
  await assert.rejects(
    runner.run("local.qa-checks", { commands: ["echo looks-safe"] }, context),
    /not an approved deterministic QA check/,
  );
});

test("local noop remains the only identity operation", async () => {
  const runner = new ProcessLocalOperationRunner();
  const input = { value: 42 };
  assert.equal(
    await runner.run("local.noop", input, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    }),
    input,
  );
  assert.equal(runner.has("local.command"), false);
});
