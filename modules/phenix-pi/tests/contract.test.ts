import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRole } from "../extensions/phenix-subagents/agent-types.ts";
import {
  authorizeContract,
  type CapabilityToken,
  type ContractId,
  createCapabilityToken,
  createContractId,
  createRunId,
  hashCapabilityToken,
  issueContract,
  parseCapabilityToken,
  parseContractId,
  parseRunId,
  type RunId,
} from "../extensions/phenix-subagents/contract.ts";

const TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { const: true },
  },
};

const TEST_TASK = "Test task";
const TEST_REQUIREMENTS: readonly string[] = [];
const TEST_ROLE: AgentRole = "scout";

// Scout preset tools for consistent effective tool construction.
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
    role,
    source: {
      inherited: false,
      patch: { additional: additions, removed: removals },
    },
    effective: deduped,
  };
}

function makeContractRuntime(role: AgentRole) {
  return {
    delegation: {
      roles: {
        role,
        source: {
          inherited: false,
          patch: { additional: [] as readonly AgentRole[], removed: [] as readonly AgentRole[] },
        },
        effective: [] as readonly AgentRole[],
      },
      availableRoles: [] as readonly AgentRole[],
      remainingDepth: 2,
    },
    workflow: {
      instanceId: "test-instance",
      actorId: "test-actor",
      definitionId: "phenix-default" as const,
      difficulty: "D1" as const,
      initialState: "classified" as const,
      transitionAuthority: { kind: "unrestricted" } as const,
      capabilityArtifactHash: "0000000000000000000000000000000000000000000000000000000000000000",
    },
  };
}

function issueTestContract(role: AgentRole = TEST_ROLE): {
  contractId: ContractId;
  runId: RunId;
  role: AgentRole;
  capabilityToken: CapabilityToken;
} {
  const runId = createRunId();
  const tools = makeToolConfig(role);
  const runtimeParts = makeContractRuntime(role);
  const issued = issueContract({
    identity: {
      runId,
      handleId: "test-handle",
      role,
    },
    assignment: {
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    },
    runtime: {
      agent: role === null ? "phenix.base" : `phenix.${role}`,
      cwd: "/tmp",
      thinking: "medium",
      tools,
      skills: [],
      extensions: [],
      delegation: runtimeParts.delegation,
      workflow: runtimeParts.workflow,
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
  return {
    contractId: issued.artifact.id,
    runId: issued.artifact.identity.runId,
    role: issued.artifact.identity.role,
    capabilityToken: issued.capabilityToken,
  };
}

describe("Contract domain", () => {
  it("issue creates unique contract IDs", () => {
    const a = issueTestContract();
    const b = issueTestContract();
    assert.notEqual(a.contractId, b.contractId);
  });

  it("issue creates unique capability tokens", () => {
    const a = issueTestContract();
    const b = issueTestContract();
    assert.notEqual(a.capabilityToken, b.capabilityToken);
  });

  it("token hash differs from raw token", () => {
    const issued = issueTestContract();
    const rawHash = hashCapabilityToken(issued.capabilityToken);
    assert.notEqual(rawHash, issued.capabilityToken);
    assert.equal(rawHash.length, 64);
  });

  it("correct identity authorizes", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime("scout");
    const issued = issueContract({
      identity: { runId, handleId: "test", role: "scout" as AgentRole },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp",
        thinking: "medium",
        tools: makeToolConfig("scout"),
        skills: [],
        extensions: [],
        delegation: runtimeParts.delegation,
        workflow: runtimeParts.workflow,
        timeoutMs: 600_000,
        turnBudget: { maxTurns: 24, graceTurns: 2 },
        toolBudget: { soft: 60, hard: 80, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 1 },
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: issued.artifact.identity.runId,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("wrong contract ID rejects", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime("scout");
    const issued = issueContract({
      identity: { runId, handleId: "test", role: "scout" as AgentRole },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp",
        thinking: "medium",
        tools: makeToolConfig("scout"),
        skills: [],
        extensions: [],
        delegation: runtimeParts.delegation,
        workflow: runtimeParts.workflow,
        timeoutMs: 600_000,
        turnBudget: { maxTurns: 24, graceTurns: 2 },
        toolBudget: { soft: 60, hard: 80, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 1 },
    });
    const result = authorizeContract(issued.artifact, {
      contractId: `phx_00000000-0000-0000-0000-000000000000` as ContractId,
      runId: issued.artifact.identity.runId,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: false, reason: "contract-id-mismatch" });
  });

  it("wrong run ID rejects", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime("scout");
    const issued = issueContract({
      identity: { runId, handleId: "test", role: "scout" as AgentRole },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp",
        thinking: "medium",
        tools: makeToolConfig("scout"),
        skills: [],
        extensions: [],
        delegation: runtimeParts.delegation,
        workflow: runtimeParts.workflow,
        timeoutMs: 600_000,
        turnBudget: { maxTurns: 24, graceTurns: 2 },
        toolBudget: { soft: 60, hard: 80, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 1 },
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: `run_00000000-0000-0000-0000-000000000000` as RunId,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: false, reason: "run-id-mismatch" });
  });

  it("wrong token rejects", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime("scout");
    const issued = issueContract({
      identity: { runId, handleId: "test", role: "scout" as AgentRole },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp",
        thinking: "medium",
        tools: makeToolConfig("scout"),
        skills: [],
        extensions: [],
        delegation: runtimeParts.delegation,
        workflow: runtimeParts.workflow,
        timeoutMs: 600_000,
        turnBudget: { maxTurns: 24, graceTurns: 2 },
        toolBudget: { soft: 60, hard: 80, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 1 },
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: issued.artifact.identity.runId,
      capabilityToken: createCapabilityToken(),
    });
    assert.deepEqual(result, { ok: false, reason: "invalid-capability" });
  });

  it("expired contract rejects", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime("scout");
    const issued = issueContract({
      identity: { runId, handleId: "test", role: "scout" as AgentRole },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.scout",
        cwd: "/tmp",
        thinking: "medium",
        tools: makeToolConfig("scout"),
        skills: [],
        extensions: [],
        delegation: runtimeParts.delegation,
        workflow: runtimeParts.workflow,
        timeoutMs: 600_000,
        turnBudget: { maxTurns: 24, graceTurns: 2 },
        toolBudget: { soft: 60, hard: 80, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 1 },
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    const result = authorizeContract(
      issued.artifact,
      {
        contractId: issued.artifact.id,
        runId: issued.artifact.identity.runId,
        capabilityToken: issued.capabilityToken,
      },
      new Date(),
    );
    assert.deepEqual(result, { ok: false, reason: "expired" });
  });

  it("parseContractId validates format", () => {
    const id = createContractId();
    assert.equal(parseContractId(id), id);
    assert.equal(parseContractId("invalid"), undefined);
    assert.equal(parseContractId(""), undefined);
    assert.equal(parseContractId(123), undefined);
  });

  it("parseRunId validates format", () => {
    const id = createRunId();
    assert.equal(parseRunId(id), id);
    assert.equal(parseRunId("invalid"), undefined);
    assert.equal(parseRunId(""), undefined);
  });

  it("parseCapabilityToken validates length", () => {
    const token = createCapabilityToken();
    assert.equal(parseCapabilityToken(token), token);
    assert.equal(parseCapabilityToken("short"), undefined);
    assert.equal(parseCapabilityToken(""), undefined);
  });

  it("artifact has complete runtime fields", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime(null);
    const issued = issueContract({
      identity: { runId, handleId: "test", role: null },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.base",
        cwd: "/tmp",
        thinking: "low",
        tools: makeToolConfig(null),
        skills: [],
        extensions: [],
        delegation: { ...runtimeParts.delegation, remainingDepth: 0 },
        workflow: runtimeParts.workflow,
        timeoutMs: 300_000,
        turnBudget: { maxTurns: 12, graceTurns: 2 },
        toolBudget: { soft: 30, hard: 40, block: ["read"] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 0 },
    });
    assert.equal(issued.artifact.identity.role, null);
    assert.equal(issued.artifact.identity.handleId, "test");
    assert.equal(issued.artifact.assignment.task, TEST_TASK);
    assert.equal(issued.artifact.runtime.agent, "phenix.base");
    assert.equal(issued.artifact.runtime.delegation.remainingDepth, 0);
    assert.ok(typeof issued.artifact.capabilityTokenHash === "string");
    assert.ok(issued.artifact.capabilityTokenHash.length > 0);
  });

  it("role null is stored correctly in contract identity", () => {
    const runId = createRunId();
    const runtimeParts = makeContractRuntime(null);
    const issued = issueContract({
      identity: { runId, handleId: "test-null-role", role: null },
      assignment: { task: TEST_TASK, requirements: TEST_REQUIREMENTS, outputSchema: TEST_SCHEMA },
      runtime: {
        agent: "phenix.base",
        cwd: "/tmp",
        thinking: "low",
        tools: makeToolConfig(null),
        skills: [],
        extensions: [],
        delegation: { ...runtimeParts.delegation, remainingDepth: 0 },
        workflow: runtimeParts.workflow,
        timeoutMs: 300_000,
        turnBudget: { maxTurns: 12, graceTurns: 2 },
        toolBudget: { soft: 30, hard: 40, block: [] },
      },
      verification: { commands: [], criticRequired: false, maxRepairAttempts: 0 },
    });

    assert.equal(issued.artifact.identity.role, null);
    assert.equal(issued.artifact.identity.handleId, "test-null-role");
  });
});
