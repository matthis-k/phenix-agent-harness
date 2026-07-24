import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import { definitionId, runId } from "../domain/shared.ts";
import { createUnboundedWidget, renderDashboard, renderRuns } from "../extension/run-monitor.ts";

const ROOT = runId("root-monitor");

test("run widget renders the complete run tree without a height cap", () => {
  const children = Array.from(
    { length: 50 },
    (_, index): RunTreeNode => ({
      run: snapshot(runId(`run-${index}`), ROOT, "agent.scout"),
      children: [],
    }),
  );
  const lines = renderRuns(
    {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children,
      },
    },
    [],
    123,
  );

  assert.equal(lines.filter((line) => line.includes("scout [running]")).length, 50);
  assert.equal(
    lines.some((line) => line.includes("run tree truncated")),
    false,
  );
});

test("widget component factory bypasses Pi's string-array line cap", () => {
  const lines = Array.from({ length: 50 }, (_, index) => `widget-line-${index}`);
  const rendered = createUnboundedWidget(lines)().render(120);

  assert.equal(rendered.length, 50);
  assert.equal(rendered[0]?.trim(), "widget-line-0");
  assert.equal(rendered.at(-1)?.trim(), "widget-line-49");
  assert.equal(
    rendered.some((line) => line.includes("widget truncated")),
    false,
  );
});

test("dashboard collapses completed workflows and shows concrete model and thinking per child", () => {
  const workflowId = runId("run-workflow");
  const scoutId = runId("run-scout");
  const workflow: RunTreeNode = {
    run: { ...snapshot(workflowId, ROOT, "workflow.qa"), kind: "workflow", state: "completed" },
    children: [
      {
        run: {
          ...snapshot(scoutId, workflowId, "agent.scout"),
          state: "completed",
          resolvedModel: {
            requested: { kind: "session" },
            concrete: { kind: "concrete", provider: "opencode-go", model: "model-a" },
            thinking: "low",
            policyRevision: "test",
          },
        },
        children: [],
      },
    ],
  };
  const facts: RunFact[] = [
    factFor(workflowId, "2026-07-24T00:01:00.000Z", "child-finished", "Completed qa"),
    factFor(scoutId, "2026-07-24T00:00:30.000Z", "child-finished", "Completed scout"),
  ];
  const base = {
    tree: {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children: [workflow],
      },
    },
    facts,
    sequence: 20,
    profile: { agent: "base" as const, modelSet: "mixed" as const, difficulty: "D2" as const },
    diagnostics: {
      total: 12,
      artifacts: 2,
      counts: { trace: 5, info: 4, warning: 2, error: 1 },
    },
    ledger: "/state/events.jsonl",
    logs: "/state/logs.jsonl",
    artifacts: "/state/artifacts",
    integrations: "5/6 loaded; failed: mcp",
    integrationsFailed: true,
  };

  const collapsed = renderDashboard({ ...base, expanded: false });
  assert.equal(
    collapsed.some((line) => line.includes("qa [completed] · 1 children · 1m 0s")),
    true,
  );
  assert.equal(
    collapsed.some((line) => line.includes("opencode-go/model-a")),
    false,
  );

  const expanded = renderDashboard({ ...base, expanded: true });
  assert.equal(
    expanded.some((line) => line.includes("scout [completed]")),
    true,
  );
  assert.equal(
    expanded.some((line) => line.includes("opencode-go/model-a · low")),
    true,
  );
  assert.equal(
    expanded.some((line) => line.includes("Recent facts")),
    true,
  );
  assert.equal(
    expanded.some((line) => line.includes("1 errors")),
    true,
  );
});

function snapshot(
  id: ReturnType<typeof runId>,
  parentId: ReturnType<typeof runId> | undefined,
  definition: string,
): RunSnapshot {
  const resolvedDefinition = definitionId(definition);
  return {
    id,
    ...(parentId ? { parentId } : {}),
    kind: parentId ? "agent" : "root",
    definitionId: resolvedDefinition,
    input: {},
    outputSchemaId: "test.output",
    requestedAt: "2026-07-24T00:00:00.000Z",
    ownership: "attached",
    state: "running",
    revision: 1,
    compiled: {
      definitionId: resolvedDefinition,
      input: {},
      outputSchemaId: "test.output",
      tools: [],
      limits: { timeoutMs: 0 },
      capabilities: {
        invokableDefinitions: [],
        maxDepth: 8,
        mayDetach: false,
        maySend: false,
        mayCancelChildren: false,
      },
      invocation: { wait: "background" },
    },
    activeChildren: [],
  };
}

function factFor(
  id: ReturnType<typeof runId>,
  timestamp: string,
  kind: RunFact["kind"],
  summary: string,
): RunFact {
  return {
    id: `fact-${id}`,
    rootRunId: ROOT,
    runId: id,
    sequence: 1,
    timestamp,
    kind,
    source: "runtime",
    summary,
    provenance: {},
    reliability: "observed",
  };
}
