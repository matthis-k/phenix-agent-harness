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
  },
  {
    id: WORKFLOW_IMPLEMENT,
    kind: "workflow",
    title: "Verified implementation",
    description: "Plan, implement, verify, and repair one bounded change.",
  },
  {
    id: AGENT_COORDINATOR,
    kind: "agent",
    title: "Dynamic coordinator",
    description: "Compose multiple workflows when no single invariant graph fits.",
  },
  {
    id: AGENT_DISPATCHER,
    kind: "agent",
    title: "Dispatcher",
    description: "Internal selector.",
  },
  {
    id: AGENT_BASE,
    kind: "agent",
    title: "Base",
    description: "Internal escape hatch.",
  },
];

test("derives selector candidates from allowed workflows plus the generic coordinator", () => {
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

test("dispatcher prompt prefers a specific workflow over the generic coordinator", () => {
  const candidates = selectDispatchCandidates(available) as readonly DispatchCandidate[];
  const prompt = dispatcherDefinition.prompt.render({
    objective: "Do a full QA pass",
    candidates,
  });
  assert.match(prompt, /Prefer the most specific workflow/);
  assert.match(prompt, /Do not choose the generic coordinator merely because it is flexible/);
  assert.match(prompt, /workflow\.qa/);
  assert.match(prompt, /Run deterministic checks and independent repository reviews/);
});
