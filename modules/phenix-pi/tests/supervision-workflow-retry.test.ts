import assert from "node:assert/strict";
import test from "node:test";

import {
  summarizeWorkflowRetryStart,
  summarizeWorkflowTerminal,
} from "../application/supervision-process-manager.ts";
import type { RunRecord } from "../domain/run/model.ts";
import { failed, type RunId } from "../domain/shared.ts";

const capabilities = {
  invokableDefinitions: [],
  maxDepth: 4,
  mayDetach: false,
  maySend: false,
  mayCancelChildren: false,
};

function compiled(
  timeoutMs: number,
  input: {
    readonly retryOf?: RunId;
    readonly nodeId?: string;
    readonly activationId?: string;
  } = {},
): RunRecord["compiled"] {
  return {
    definitionId: "agent.critic" as RunRecord["definitionId"],
    input: {},
    outputSchemaId: "outcome.critic-report.v1",
    tools: ["read"],
    limits: { timeoutMs, maxRepairAttempts: 0 },
    capabilities,
    invocation: {
      wait: "await",
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      ...(input.nodeId && input.activationId
        ? {
            causation: {
              workflowRunId: "run-workflow" as RunId,
              nodeId: input.nodeId,
              activationId: input.activationId,
            },
          }
        : {}),
    },
  };
}

test("workflow retry notice is compact and states retained work", () => {
  const originalId = "run-critic-1" as RunId;
  const original = {
    compiled: compiled(480_000),
    outcome: failed({
      code: "timeout",
      message: "Agent timed out after 480000ms",
      retryable: true,
      details: { suggestedLimits: { timeoutMs: 960_000 } },
    }),
  };
  const retry = {
    compiled: compiled(960_000, {
      retryOf: originalId,
      nodeId: "security",
      activationId: "activation-security",
    }),
  };

  const notice = summarizeWorkflowRetryStart(retry, original, {
    definitionId: "workflow.qa" as RunRecord["definitionId"],
  });

  assert.match(notice, /workflow\.qa state security is retrying/);
  assert.match(notice, /timeout/);
  assert.match(notice, /"timeoutMs":960000/);
  assert.match(notice, /Completed workflow states are retained/);
  assert.doesNotMatch(notice, /Recovery run/);
});

test("exhausted workflow recovery is final and does not recommend a full restart", () => {
  const notice = summarizeWorkflowTerminal({
    id: "run-workflow" as RunId,
    definitionId: "workflow.qa" as RunRecord["definitionId"],
    outcome: failed({
      code: "timeout",
      message: "Agent timed out after 960000ms",
      retryable: true,
      causeRunId: "run-critic-2" as RunId,
    }),
  });

  assert.match(notice, /declared recovery policy was exhausted/);
  assert.match(notice, /Completed states were not rerun/);
  assert.match(notice, /Do not restart the full workflow automatically/);
  assert.doesNotMatch(notice, /bounded retry may be appropriate/);
});
