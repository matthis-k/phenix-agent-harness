import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, before, after } from "node:test";

import {
  FileContractStore,
  ContractStoreError,
} from "../extensions/phenix-subagents/contract-store.ts";
import {
  issueContract,
  createRunId,
  type ContractArtifact,
  type ContractId,
} from "../extensions/phenix-subagents/contract.ts";

const TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { const: true } },
};

function createTestArtifact(): ContractArtifact {
  const runId = createRunId();
  const issued = issueContract({
    identity: {
      runId,
      handleId: "test-handle",
      role: "scout",
    },
    assignment: {
      task: "test task",
      requirements: [],
      outputSchema: TEST_SCHEMA,
    },
    runtime: {
      agent: "phenix.scout",
      cwd: "/tmp",
      thinking: "medium",
      tools: {
        presetRevision: 1 as const,
        role: "scout",
        source: {
          inherited: false,
          patch: { additional: [] as const, removed: [] as const },
        },
        effective: [] as const,
      },
      skills: [],
      extensions: [],
      allowedChildren: [],
      maxDelegationDepth: 2,
      timeoutMs: 600_000,
      turnBudget: { maxTurns: 24, graceTurns: 2 },
      toolBudget: { soft: 60, hard: 80, block: [] },
    },
    verification: {
      commands: [],
      criticRequired: false,
      maxRepairAttempts: 1,
    },
  });
  return issued.artifact;
}

describe("FileContractStore", () => {
  let tmpDir: string;
  let store: FileContractStore;

  before(() => {
    tmpDir = path.join(os.tmpdir(), `phenix-contract-store-test-${randomUUID()}`);
    store = new FileContractStore(tmpDir);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create writes artifact and pending result", async () => {
    const artifact = createTestArtifact();
    const result = await store.create(artifact);
    assert.equal(result.state, "pending");
    assert.equal(result.contractId, artifact.id);
    assert.equal(result.revision, 0);

    // Verify persistence
    const loaded = await store.load(artifact.id);
    assert(loaded !== undefined);
    assert.equal(loaded.artifact.id, artifact.id);
    assert.equal(loaded.result.state, "pending");
  });

  it("submit transitions pending to submitted", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    const result = await store.submit(artifact.id, 0, { ok: true });
    assert.equal(result.state, "submitted");
    assert.equal(result.revision, 1);
    assert.deepEqual(result.value, { ok: true });
  });

  it("second submit rejects", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await store.submit(artifact.id, 0, { ok: true });
    await assert.rejects(
      () => store.submit(artifact.id, 1, { ok: true }),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "already-terminal",
    );
  });

  it("cancel transitions pending to cancelled", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    const result = await store.cancel(artifact.id, "test cancellation");
    assert.equal(result.state, "cancelled");
    assert.equal(result.reason, "test cancellation");
  });

  it("submit after cancel rejects", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await store.cancel(artifact.id, "cancelled");
    await assert.rejects(
      () => store.submit(artifact.id, 0, { ok: true }),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "already-terminal",
    );
  });

  it("revision mismatch rejects", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await assert.rejects(
      () => store.submit(artifact.id, 42, { ok: true }),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "revision-conflict",
    );
  });

  it("load returns undefined for missing contract", async () => {
    const result = await store.load(`phx_${randomUUID()}` as ContractId);
    assert.equal(result, undefined);
  });

  it("malformed persisted JSON throws on load", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    // Corrupt the artifact file
    const dir = path.join(tmpDir, artifact.id);
    const artifactFile = path.join(dir, "contract.json");
    fs.writeFileSync(artifactFile, "not valid json{{{");

    await assert.rejects(
      () => store.load(artifact.id),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "io-failure",
    );
  });

  it("atomic write leaves no partial file on success", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    const dir = path.join(tmpDir, artifact.id);
    const files = fs.readdirSync(dir);
    assert(files.includes("contract.json"));
    assert(files.includes("result.json"));
    // No .tmp files should be left
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0);
  });

  it("create rejects duplicate ID", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await assert.rejects(
      () => store.create(artifact),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "revision-conflict",
    );
  });

  it("cancel on missing contract rejects", async () => {
    await assert.rejects(
      () => store.cancel(`phx_${randomUUID()}` as ContractId, "cancel-missing"),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "not-found",
    );
  });

  it("submit on missing contract rejects", async () => {
    await assert.rejects(
      () => store.submit(`phx_${randomUUID()}` as ContractId, 0, { ok: true }),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "not-found",
    );
  });
});
