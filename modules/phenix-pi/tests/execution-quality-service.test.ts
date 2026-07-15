import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  ChildRun,
  ContractSubmissionChannel,
} from "../extensions/phenix-runtime/child-session-types.ts";
import type { SubagentExecutionPlan } from "../extensions/phenix-runtime/execution-plan.ts";
import type { ResolvedChildSpec } from "../extensions/phenix-subagents/child-spec.ts";
import {
  ExecutionQualityService,
  type ExecutionQualitySessionRuntime,
} from "../extensions/phenix-subagents/execution-quality-service.ts";
import type { HandleRecord } from "../extensions/phenix-subagents/handle-types.ts";

const CRITIC_TOOLS = [
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
  "phenix_delegate",
] as const;

function temporaryDirectory(prefix: string): string {
  const directory = path.join(os.tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function criticSpec(cwd: string): ResolvedChildSpec {
  return {
    role: "critic",
    agent: "phenix.critic",
    profile: {} as never,
    tier: "standard" as never,
    thinking: "medium",
    cwd,
    tools: {
      presetRevision: 1,
      role: "critic",
      source: {
        inherited: false,
        patch: { additional: [], removed: [] },
      },
      effective: CRITIC_TOOLS,
    },
    skills: [],
    extensions: [],
    delegation: {
      roles: {
        presetRevision: 1,
        role: "critic",
        source: {
          inherited: false,
          patch: { additional: [], removed: [] },
        },
        effective: ["scout", "tester"],
      },
      availableRoles: ["scout", "tester"],
      remainingDepth: 0,
    },
    workflow: {
      instanceId: "quality-instance",
      actorId: "quality-critic",
      parentActorId: "quality-producer",
      definitionId: "phenix-default",
      definitionVersion: 1,
      difficulty: "D2",
      initialState: "reviewing",
      transitionAuthority: { kind: "restricted", allowed: [] },
      capabilityArtifactHash: "0".repeat(64),
    },
    timeoutMs: 1_000,
    turnBudget: { maxTurns: 24, graceTurns: 2 },
    toolBudget: { soft: 60, hard: 80, block: [] },
    verificationCommands: [],
    criticRequired: false,
    maxRepairAttempts: 0,
  };
}

function record(cwd: string): HandleRecord {
  const timestamp = new Date().toISOString();
  return {
    version: 5,
    id: "quality-test",
    sessionId: "quality-session",
    modelSet: "mixed",
    assignment: {
      task: "Implement the requested refactor.",
      requirements: ["Keep runtime boundaries explicit."],
      outputSchema: { type: "object" },
    },
    producerSpec: {
      verificationCommands: [],
      criticRequired: true,
    } as HandleRecord["producerSpec"],
    criticSpec: criticSpec(cwd),
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

class RecordingSessions implements ExecutionQualitySessionRuntime {
  readonly plans: SubagentExecutionPlan<unknown>[] = [];
  disposed = 0;

  async spawn(execution: SubagentExecutionPlan<unknown>): Promise<ChildRun> {
    this.plans.push(execution);
    const channel = execution.runtime.contractChannel as ContractSubmissionChannel;
    await channel.submit({
      verdict: "approve",
      summary: "The implementation satisfies the contract.",
      findings: [],
      missingRequirements: [],
    });

    return {
      id: execution.runtime.id,
      backend: "sdk",
      pi: { sessionId: "pi-quality-critic" },
      snapshot: () => ({}) as ReturnType<ChildRun["snapshot"]>,
      subscribe: () => () => undefined,
      continue: async () => ({ cycle: 2, status: "settled" }),
      waitForCurrentCycle: async () => ({ cycle: 1, status: "settled" }),
      abort: async () => undefined,
      dispose: async () => {
        this.disposed++;
      },
    };
  }
}

describe("ExecutionQualityService", () => {
  it("projects deterministic verification failures into acceptance issues", async () => {
    const sessions = new RecordingSessions();
    const service = new ExecutionQualityService({
      sessions,
      runVerification: async () => [
        {
          id: "unit",
          command: "npm test",
          cwd: "/tmp",
          status: "failed",
          exitCode: 1,
          stderr: "one test failed",
          durationMs: 10,
        },
      ],
    });
    const value = record("/tmp");

    const result = await service.verify({
      record: value,
      value: { ok: false },
      cwd: "/tmp",
      signal: new AbortController().signal,
    });

    assert.equal(result.ok, false);
    assert.equal(result.summary.acceptanceStatus, "rejected");
    assert.deepEqual(result.issues, [
      {
        path: ["verification", "unit"],
        code: "failed",
        message: 'Verification command "unit" failed.\none test failed',
      },
    ]);
  });

  it("runs critics through the canonical session plan and accepts their verdict", async () => {
    const cwd = temporaryDirectory("phenix-quality-service");
    const sessions = new RecordingSessions();
    const service = new ExecutionQualityService({ sessions });

    const result = await service.review({
      record: record(cwd),
      producerValue: { changed: true },
      verification: {
        acceptanceStatus: "verified",
        runtimeChecks: [],
        verifyRuns: ["unit: passed"],
        reviewFindings: [],
        contract: "valid",
      },
      cwd,
      signal: new AbortController().signal,
    });

    assert.equal(result.verdict, "approve");
    assert.equal(sessions.plans.length, 1);
    assert.equal(sessions.plans[0]?.session.defaults.agent, "critic");
    assert.equal(sessions.plans[0]?.session.defaults.modelSet, "mixed");
    assert.equal(sessions.plans[0]?.acceptance.kind, "critic");
    assert.equal(sessions.plans[0]?.runtime.parentContext.maximumDelegationDepth, 0);
    assert.equal(sessions.disposed, 1);
  });

  it("fails explicitly when a required critic specification is absent", async () => {
    const sessions = new RecordingSessions();
    const service = new ExecutionQualityService({ sessions });
    const value = { id: "quality-test", criticSpec: undefined } as unknown as HandleRecord;

    await assert.rejects(
      service.review({
        record: value,
        producerValue: {},
        verification: {
          acceptanceStatus: "verified",
          runtimeChecks: [],
          verifyRuns: [],
          reviewFindings: [],
          contract: "valid",
        },
        cwd: "/tmp",
        signal: new AbortController().signal,
      }),
      /Required critic specification is missing/,
    );
  });
});
