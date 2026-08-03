import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProcessRtkTokenReductionBackend,
  type RtkExecutor,
} from "../adapters/process/rtk-token-reduction-backend.ts";
import { runId } from "../domain/shared.ts";

function executor(code: number, stdout: string): RtkExecutor {
  return async () => ({ code, stdout, stderr: "" });
}

test("accepts RTK advisory rewrites and scopes lossless recovery per tool call", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "phenix-rtk-"));
  const backend = new ProcessRtkTokenReductionBackend({
    executable: "/nix/store/rtk/bin/rtk",
    stateDirectory,
    execute: executor(3, "rtk git status"),
  });
  const preparation = await backend.prepare({
    runId: runId("run-root"),
    toolCallId: "call-1",
    cwd: "/workspace",
    command: "git status",
  });

  assert.equal(preparation.kind, "rewrite");
  if (preparation.kind !== "rewrite") return;
  assert.match(preparation.command, /^env PHENIX_RTK_LOSSLESS=1 /);
  assert.match(preparation.command, /RTK_TEE=1/);
  assert.match(preparation.command, /RTK_TEE_DIR=/);
  assert.match(preparation.command, /XDG_CONFIG_HOME=/);
  assert.match(preparation.command, /rtk git status$/);

  const directory = path.join(
    stateDirectory,
    "token-reduction",
    "rtk",
    "pending",
    preparation.recoveryKey,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "001-complete.log"), "complete command output");
  await writeFile(path.join(directory, "999-partial.log"), "partial");
  assert.deepEqual(await backend.recover(preparation), {
    content: "complete command output",
    complete: true,
  });

  await backend.cleanup(preparation);
  assert.equal(await backend.recover(preparation), undefined);
});

test("treats RTK exit code one as a normal passthrough", async () => {
  const backend = new ProcessRtkTokenReductionBackend({
    executable: "rtk",
    stateDirectory: await mkdtemp(path.join(os.tmpdir(), "phenix-rtk-")),
    execute: executor(1, ""),
  });

  assert.deepEqual(
    await backend.prepare({
      runId: runId("run-root"),
      toolCallId: "call-2",
      cwd: "/workspace",
      command: "printf hello",
    }),
    { kind: "passthrough", backend: "rtk", reason: "not-reducible" },
  );
});

test("bypasses reduction when the command disables RTK tee recovery", async () => {
  const backend = new ProcessRtkTokenReductionBackend({
    executable: "rtk",
    stateDirectory: await mkdtemp(path.join(os.tmpdir(), "phenix-rtk-")),
    execute: executor(0, "rtk git status"),
  });

  assert.deepEqual(
    await backend.prepare({
      runId: runId("run-root"),
      toolCallId: "call-3",
      cwd: "/workspace",
      command: "RTK_TEE=0 git status",
    }),
    { kind: "passthrough", backend: "rtk", reason: "disabled" },
  );
});

test("rejects multiline backend output instead of executing an ambiguous rewrite", async () => {
  const backend = new ProcessRtkTokenReductionBackend({
    executable: "rtk",
    stateDirectory: await mkdtemp(path.join(os.tmpdir(), "phenix-rtk-")),
    execute: executor(0, "rtk git status\necho injected"),
  });

  assert.deepEqual(
    await backend.prepare({
      runId: runId("run-root"),
      toolCallId: "call-4",
      cwd: "/workspace",
      command: "git status",
    }),
    { kind: "passthrough", backend: "rtk", reason: "unsafe-rewrite" },
  );
});
