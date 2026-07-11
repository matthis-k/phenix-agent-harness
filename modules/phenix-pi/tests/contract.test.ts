import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeContract,
  createCapabilityToken,
  createContractId,
  createRunId,
  hashCapabilityToken,
  issueContract,
  parseCapabilityToken,
  parseContractId,
  parseRunId,
  type CapabilityToken,
  type ContractId,
  type RunId,
} from "../extensions/phenix-subagents/contract.ts";
import { type AgentKind } from "../extensions/phenix-subagents/policy.ts";

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
const TEST_ROLE: AgentKind = "scout";

function issueTestContract(): {
  contractId: ContractId;
  runId: RunId;
  role: AgentKind;
  capabilityToken: CapabilityToken;
} {
  const runId = createRunId();
  const issued = issueContract({
    runId,
    role: TEST_ROLE,
    task: TEST_TASK,
    requirements: TEST_REQUIREMENTS,
    outputSchema: TEST_SCHEMA,
  });
  return {
    contractId: issued.artifact.id,
    runId: issued.artifact.runId,
    role: issued.artifact.role,
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
    assert.equal(rawHash.length, 64); // sha256 hex
  });

  it("correct identity authorizes", () => {
    const { contractId, runId, role, capabilityToken } = issueTestContract();
    // We need the actual artifact to test authorization.
    // Re-issue and capture the artifact.
    const runId2 = createRunId();
    const issued = issueContract({
      runId: runId2,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: issued.artifact.runId,
      role: issued.artifact.role,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: true });
  });

  it("wrong contract ID rejects", () => {
    const runId = createRunId();
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    });
    const result = authorizeContract(issued.artifact, {
      contractId: `phx_00000000-0000-0000-0000-000000000000` as ContractId,
      runId: issued.artifact.runId,
      role: issued.artifact.role,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: false, reason: "contract-id-mismatch" });
  });

  it("wrong run ID rejects", () => {
    const runId = createRunId();
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: `run_00000000-0000-0000-0000-000000000000` as RunId,
      role: issued.artifact.role,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: false, reason: "run-id-mismatch" });
  });

  it("wrong role rejects", () => {
    const runId = createRunId();
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: issued.artifact.runId,
      role: "implementer" as AgentKind,
      capabilityToken: issued.capabilityToken,
    });
    assert.deepEqual(result, { ok: false, reason: "role-mismatch" });
  });

  it("wrong token rejects", () => {
    const runId = createRunId();
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
    });
    const result = authorizeContract(issued.artifact, {
      contractId: issued.artifact.id,
      runId: issued.artifact.runId,
      role: issued.artifact.role,
      capabilityToken: createCapabilityToken(),
    });
    assert.deepEqual(result, { ok: false, reason: "invalid-capability" });
  });

  it("expired contract rejects", () => {
    const runId = createRunId();
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    const result = authorizeContract(
      issued.artifact,
      {
        contractId: issued.artifact.id,
        runId: issued.artifact.runId,
        role: issued.artifact.role,
        capabilityToken: issued.capabilityToken,
      },
      new Date(),
    );
    assert.deepEqual(result, { ok: false, reason: "expired" });
  });

  it("non-expired contract authorizes at expiry boundary", () => {
    const runId = createRunId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3600_000);
    const issued = issueContract({
      runId,
      role: TEST_ROLE,
      task: TEST_TASK,
      requirements: TEST_REQUIREMENTS,
      outputSchema: TEST_SCHEMA,
      expiresAt: expiresAt.toISOString(),
    });
    const result = authorizeContract(
      issued.artifact,
      {
        contractId: issued.artifact.id,
        runId: issued.artifact.runId,
        role: issued.artifact.role,
        capabilityToken: issued.capabilityToken,
      },
      now,
    );
    assert.deepEqual(result, { ok: true });
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
});
