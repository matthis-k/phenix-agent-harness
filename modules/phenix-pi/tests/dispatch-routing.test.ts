import assert from "node:assert/strict";
import test from "node:test";

import {
  requireSelectedCandidate,
  selectDispatchCandidates,
} from "../application/dispatch-service.ts";
import type { DefinitionSummary } from "../application/interfaces.ts";
import { dispatcherDefinition } from "../definitions/agents.ts";
import type { DispatchCandidate } from "../definitions/dispatch.ts";
import {
  AGENT_BASE,
  AGENT_COORDINATOR,
  AGENT_DISPATCHER,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
} from "../definitions/ids.ts";

const available: readonly DefinitionSummary[] = [
  {
    id: WORKFLOW_QA,
    kind: "workflow",
    title: "Repository QA",
    description: "Run deterministic checks and independent repository reviews.",
    inputSchema: "request.objective",
    outputSchema: "outcome.qa-report",
  },
  {
    id: WORKFLOW_IMPLEMENT,
    kind: "workflow",
    title: "Verified implementation",
    description: "Plan, implement, verify, and repair one bounded change.",
    inputSchema: "request.implementation",
    outputSchema: "outcome.implementation-result",
  },
  {
    id: AGENT_COORDINATOR,
    kind: "agent",
    title: "Dynamic composer",
    description: "Propose a typed graph when no single invariant workflow fits.",
    inputSchema: "request.dynamic-workflow-composition",
    outputSchema: "request.dynamic-workflow-proposal",
  },
  {
    id: AGENT_DISPATCHER,
    kind: "agent",
    title: "Dispatcher",
    description: "Internal selector.",
    inputSchema: "request.dispatch-selection",
    outputSchema: "outcome.dispatch-decision",
  },
  {
    id: AGENT_BASE,
    kind: "agent",
    title: "Base",
    description: "Internal escape hatch.",
    inputSchema: "request.objective",
    outputSchema: "outcome.base",
  },
];

test("derives selector candidates from allowed workflows plus the dynamic composer", () => {
  assert.deepEqual(
    selectDispatchCandidates(available).map((candidate) => candidate.definitionId),
    [WORKFLOW_QA, WORKFLOW_IMPLEMENT, AGENT_COORDINATOR],
  );
});

test("rejects a selector decision outside the offered catalog candidates", () => {
  const candidates = selectDispatchCandidates(available);
  assert.throws(
    () =>
      requireSelectedCandidate(candidates, {
        definitionId: AGENT_BASE,
        reason: "too flexible",
        confidence: 1,
      }),
    /unavailable definition agent\.base/,
  );
});

test("dispatcher keeps candidate data out of the system prompt", () => {
  const candidates = selectDispatchCandidates(available) as readonly DispatchCandidate[];
  const prompt = dispatcherDefinition.prompt.render();
  assert.match(prompt, /Prefer the most specific workflow/);
  assert.match(prompt, /Do not choose the generic coordinator merely because it is flexible/);
  assert.doesNotMatch(prompt, /workflow\.qa/);
  assert.doesNotMatch(prompt, /Run deterministic checks and independent repository reviews/);
  assert.ok(candidates.some((candidate) => candidate.definitionId === WORKFLOW_QA));
});
