/**
 * contract-tool-isolation.test.ts
 *
 * Create two simultaneous fake child sessions with two different contracts.
 * Verify:
 * - child A can submit only to contract A
 * - child B can submit only to contract B
 * - no process-global current context exists
 * - invalid A output does not affect B
 * - concurrent submissions do not cross-contaminate state
 */

/* biome-ignore-all lint/suspicious/noExplicitAny: isolated tool-boundary fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createCompletionTool } from "../extensions/phenix-runtime/completion-tool.ts";
import { ContractSubmissionChannelImpl } from "../extensions/phenix-runtime/contract-channel.ts";
import { createRunId, issueContract } from "../extensions/phenix-subagents/contract.ts";
import { FileContractStore } from "../extensions/phenix-subagents/contract-store.ts";

// ── Test schema ─────────────────────────────────────────────────────────────

const SCHEMA_A = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { const: "A" } },
};

const SCHEMA_B = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: { name: { const: "B" } },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function createTestArtifact(outputSchema: Record<string, unknown>, role: string) {
  const runId = createRunId();
  const issued = issueContract({
    identity: {
      runId,
      handleId: `test-${role}`,
      role: role as any,
    },
    assignment: {
      task: "test task",
      requirements: [],
      outputSchema,
    },
    runtime: {
      agent: `phenix.${role}` as any,
      cwd: "/tmp",
      thinking: "medium",
      tools: {
        role: role as any,
        source: { inherited: false, patch: { additional: [], removed: [] } },
        effective: [...SCOUT_PRESET_TOOLS],
      },
      skills: [],
      extensions: [],
      delegation: {
        roles: {
          role: role as any,
          source: { inherited: false, patch: { additional: [], removed: [] } },
          effective: [],
        },
        availableRoles: [],
        remainingDepth: 0,
      },
      workflow: {
        instanceId: "test",
        actorId: "test",
        definitionId: "phenix-default",
        difficulty: "D1" as const,
        initialState: "scouting" as const,
        transitionAuthority: { kind: "unrestricted" },
        capabilityArtifactHash: "0".repeat(64),
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
  return issued;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Contract tool isolation", () => {
  let tmpDir: string;
  let store: FileContractStore;

  before(() => {
    tmpDir = path.join(os.tmpdir(), `phenix-isolation-test-${randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new FileContractStore(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("child A can submit only to contract A", async () => {
    const issuedA = createTestArtifact(SCHEMA_A, "scout");
    await store.create(issuedA.artifact);

    const channelA = new ContractSubmissionChannelImpl(store, issuedA.artifact);
    const toolA = createCompletionTool(channelA) as any;

    // Submit valid A output
    const result = await toolA.execute(
      "call-1",
      { value: { name: "A" } },
      undefined as any,
      undefined,
      undefined as any,
    );
    assert.equal(result.isError, undefined);
    assert.equal((result.details as any).status, "submitted");
  });

  it("child B can submit only to contract B", async () => {
    const issuedB = createTestArtifact(SCHEMA_B, "planner");
    await store.create(issuedB.artifact);

    const channelB = new ContractSubmissionChannelImpl(store, issuedB.artifact);
    const toolB = createCompletionTool(channelB) as any;

    // Submit valid B output
    const result = await toolB.execute(
      "call-2",
      { value: { name: "B" } },
      undefined as any,
      undefined,
      undefined as any,
    );
    assert.equal(result.isError, undefined);
    assert.equal((result.details as any).status, "submitted");
  });

  it("invalid A output does not affect B", async () => {
    const issuedA = createTestArtifact(SCHEMA_A, "scout");
    const issuedB = createTestArtifact(SCHEMA_B, "planner");
    await store.create(issuedA.artifact);
    await store.create(issuedB.artifact);

    const channelA = new ContractSubmissionChannelImpl(store, issuedA.artifact);
    const channelB = new ContractSubmissionChannelImpl(store, issuedB.artifact);
    const toolA = createCompletionTool(channelA) as any;
    const toolB = createCompletionTool(channelB) as any;

    // Invalid A submission (wrong value)
    const invalidResult = await toolA.execute(
      "call-3",
      { value: { name: "WRONG" } },
      undefined as any,
      undefined,
      undefined as any,
    );
    assert.equal(invalidResult.isError, true);

    // A contract should still be pending (invalid submissions don't leave pending)
    const aState = channelA.current();
    assert.equal(aState.state, "pending");

    // B should be unaffected — can still submit valid B output
    const bResult = await toolB.execute(
      "call-4",
      { value: { name: "B" } },
      undefined as any,
      undefined,
      undefined as any,
    );
    assert.equal(bResult.isError, undefined);
    assert.equal((bResult.details as any).status, "submitted");
  });

  it("concurrent submissions do not cross-contaminate state", async () => {
    const issuedA = createTestArtifact(SCHEMA_A, "scout");
    const issuedB = createTestArtifact(SCHEMA_B, "planner");
    await store.create(issuedA.artifact);
    await store.create(issuedB.artifact);

    const channelA = new ContractSubmissionChannelImpl(store, issuedA.artifact);
    const channelB = new ContractSubmissionChannelImpl(store, issuedB.artifact);

    // Submit concurrently
    const [resultA, resultB] = await Promise.all([
      channelA.submit({ result: "A" }),
      channelB.submit({ result: "B" }),
    ]);

    assert.equal(resultA.ok, true);
    assert.equal(resultA.state, "submitted");
    assert.equal(resultB.ok, true);
    assert.equal(resultB.state, "submitted");

    // Each channel has its own state
    assert.equal(channelA.current().contractId, issuedA.artifact.id);
    assert.equal(channelB.current().contractId, issuedB.artifact.id);
    assert.notEqual(channelA.current().contractId, channelB.current().contractId);
  });

  it("no process-global current context exists", async () => {
    // The completion tool does not use any process-global state.
    // Each tool is closure-bound to its own channel.
    // Verify that two tools with different channels have different current() values.
    const issuedA = createTestArtifact(SCHEMA_A, "scout");
    const issuedB = createTestArtifact(SCHEMA_B, "planner");
    await store.create(issuedA.artifact);
    await store.create(issuedB.artifact);

    const channelA = new ContractSubmissionChannelImpl(store, issuedA.artifact);
    const channelB = new ContractSubmissionChannelImpl(store, issuedB.artifact);

    assert.notEqual(channelA.current().contractId, channelB.current().contractId);
    assert.notEqual(channelA.current().outputSchema, channelB.current().outputSchema);
  });
});
