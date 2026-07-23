import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProcessLocalOperationRunner } from "../adapters/process/local-operation-runner.ts";

test("QA runner reports repositories without a discoverable deterministic check", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phenix-qa-"));
  try {
    const runner = new ProcessLocalOperationRunner();
    const result = (await runner.run("local.qa-checks", {}, {
      cwd,
      signal: new AbortController().signal,
      runId: "run-test",
    })) as readonly { command: string; ok: boolean; summary: string }[];
    assert.equal(result.length, 1);
    assert.equal(result[0]?.ok, false);
    assert.match(result[0]?.summary ?? "", /No deterministic project check/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("QA runner rejects generic shell composition and unapproved commands", async () => {
  const runner = new ProcessLocalOperationRunner();
  const context = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    runId: "run-test",
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
      runId: "run-test",
    }),
    input,
  );
  assert.equal(runner.has("local.command"), false);
});
