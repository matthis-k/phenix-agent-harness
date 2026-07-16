import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentRole } from "../extensions/phenix-subagents/agent-types.ts";
import {
  type ContractId,
  createRunId,
  issueContract,
} from "../extensions/phenix-subagents/contract.ts";
import {
  ContractStoreError,
  FileContractStore,
} from "../extensions/phenix-subagents/contract-store.ts";

const TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { const: true } },
};

const SCOUT_PRESET_TOOLS = [
  "read",
  "grep",
  "search",
  "find",
  "ls",
  "tree",
  "bash",
  "lsp",
  "lsp_*",
  "ast_grep",
  "ast_*",
  "mcp",
  "mcp_*",
  "web_search",
  "web_fetch",
  "fetch_content",
  "get_search_content",
  "context_info",
  "context_*",
  "contact_supervisor",
  "phenix_workflow",
] as const;

function makeToolConfig(
  role: AgentRole,
  additions: readonly string[] = [],
  removals: readonly string[] = [],
) {
  if (role === null) {
    return {
      presetRevision: 1 as const,
      role: null,
      source: {
        inherited: false,
        patch: { additional: additions, removed: removals },
      },
      effective: [...additions],
    };
  }
  const effective = [...SCOUT_PRESET_TOOLS, ...additions].filter((t) => !removals.includes(t));
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of effective) {
    if (!seen.has(t)) {
      seen.add(t);
      deduped.push(t);
    }
  }
  return {
    presetRevision: 1 as const,
    role,
    source: {
      inherited: false,
      patch: { additional: additions, removed: removals },
    },
    effective: deduped,
  };
}

function createTestArtifact() {
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
      tools: makeToolConfig("scout"),
      skills: [],
      extensions: [],
      delegation: {
        roles: {
          presetRevision: 1 as const,
          role: "scout" as const,
          source: {
            inherited: false,
            patch: { additional: [], removed: [] },
          },
          effective: [],
        },
        availableRoles: [],
        remainingDepth: 2,
      },
      workflow: {
        instanceId: "test-instance",
        actorId: "test-actor",
        definitionId: "phenix-default",
        definitionVersion: 1,
        difficulty: "D1" as const,
        initialState: "classified" as const,
        transitionAuthority: { kind: "unrestricted" },
        capabilityArtifactHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
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
      (error: unknown) => error instanceof ContractStoreError && error.code === "already-terminal",
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
      (error: unknown) => error instanceof ContractStoreError && error.code === "already-terminal",
    );
  });

  it("revision mismatch rejects", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await assert.rejects(
      () => store.submit(artifact.id, 42, { ok: true }),
      (error: unknown) => error instanceof ContractStoreError && error.code === "revision-conflict",
    );
  });

  it("load returns undefined for missing contract", async () => {
    const result = await store.load(`phx_${randomUUID()}` as ContractId);
    assert.equal(result, undefined);
  });

  it("malformed persisted JSON throws on load", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    const dir = path.join(tmpDir, artifact.id);
    const artifactFile = path.join(dir, "contract.json");
    fs.writeFileSync(artifactFile, "not valid json{{{");

    await assert.rejects(
      () => store.load(artifact.id),
      (error: unknown) => error instanceof ContractStoreError && error.code === "io-failure",
    );
  });

  it("atomic write leaves no partial file on success", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    const dir = path.join(tmpDir, artifact.id);
    const files = fs.readdirSync(dir);
    assert(files.includes("contract.json"));
    assert(files.includes("result.json"));
    assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0);
  });

  it("create rejects duplicate ID", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await assert.rejects(
      () => store.create(artifact),
      (error: unknown) => error instanceof ContractStoreError && error.code === "revision-conflict",
    );
  });

  it("cancel on missing contract rejects", async () => {
    await assert.rejects(
      () => store.cancel(`phx_${randomUUID()}` as ContractId, "cancel-missing"),
      (error: unknown) => error instanceof ContractStoreError && error.code === "not-found",
    );
  });

  it("submit on missing contract rejects", async () => {
    await assert.rejects(
      () => store.submit(`phx_${randomUUID()}` as ContractId, 0, { ok: true }),
      (error: unknown) => error instanceof ContractStoreError && error.code === "not-found",
    );
  });

  it("reopen transitions submitted back to pending", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await store.submit(artifact.id, 0, { ok: true });
    const reopened = await store.reopen(artifact.id, 1, "runtime-rejected", [
      { path: ["ok"], message: "must be true" },
    ]);
    assert.equal(reopened.state, "pending");
    assert.equal(reopened.revision, 2);
    assert.equal(reopened.history.length, 1);
    assert.equal(reopened.history[0].disposition, "runtime-rejected");
  });

  it("accept transitions submitted to accepted", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await store.submit(artifact.id, 0, { ok: true });
    const accepted = await store.accept(artifact.id, 1);
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.revision, 2);
    assert.deepEqual(accepted.value, { ok: true });
    assert.equal(accepted.history.length, 1);
    assert.equal(accepted.history[0].disposition, "accepted");
  });

  it("reopen on non-submitted rejects", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await assert.rejects(
      () => store.reopen(artifact.id, 0, "runtime-rejected", []),
      (error: unknown) =>
        error instanceof ContractStoreError && error.code === "invalid-state-transition",
    );
  });

  it("cancel from submitted state succeeds", async () => {
    const artifact = createTestArtifact();
    await store.create(artifact);
    await store.submit(artifact.id, 0, { ok: true });
    const cancelled = await store.cancel(artifact.id, "cancelled after submit");
    assert.equal(cancelled.state, "cancelled");
  });
});
