import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import { definitionId, runId } from "../domain/shared.ts";
import { createUnboundedWidget, renderDashboard } from "../extension/run-monitor.ts";

const ROOT = runId("root-monitor");

const DIAGNOSTICS = {
  total: 0,
  artifacts: 0,
  counts: { trace: 0, info: 0, warning: 0, error: 0 },
} as const;

test("status widget renders the complete active sequence without a height cap", () => {
  const children = Array.from(
    { length: 50 },
    (_, index): RunTreeNode => ({
      run: snapshot(runId(`run-${index}`), ROOT, "agent.scout"),
      children: [],
    }),
  );
  const lines = renderDashboard({
    tree: {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children,
      },
    },
    facts: [],
    sequence: 123,
    profile: { agent: "base", modelSet: "mixed", difficulty: "D1" },
    diagnostics: DIAGNOSTICS,
    integrations: "5/5 loaded",
    integrationsFailed: false,
    expanded: false,
  });
  const output = lines.join("\n");

  assert.match(output, /Execution sequence/);
  assert.ok((output.match(/scout ·/g) ?? []).length >= 50);
  assert.doesNotMatch(output, /truncated/);
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

test("running agents render model and current activity in the sequence", () => {
  const childId = runId("run-active-scout");
  const lines = renderDashboard({
    tree: {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children: [
          {
            run: {
              ...snapshot(childId, ROOT, "agent.scout"),
              resolvedModel: {
                requested: { kind: "session" },
                concrete: {
                  kind: "concrete",
                  provider: "opencode-go",
                  model: "model-a",
                },
                thinking: "low",
                capability: "general",
              },
            },
            activity: {
              rootRunId: ROOT,
              runId: childId,
              phase: "exploring",
              summary: "Inspecting workflow scheduler",
              target: "application/workflow-process-manager.ts",
              source: "reported",
              since: "2026-07-24T00:00:10.000Z",
              sequence: 2,
            },
            children: [],
          },
        ],
      },
    },
    facts: [],
    sequence: 3,
    profile: { agent: "base", modelSet: "mixed", difficulty: "D1" },
    diagnostics: DIAGNOSTICS,
    integrations: "5/5 loaded",
    integrationsFailed: false,
    expanded: false,
  });
  const output = lines.join("\n");

  assert.match(output, /scout ·/);
  assert.match(output, /opencode-go\/model-a · low/);
  assert.match(output, /! exploring Inspecting workflow scheduler/);
  assert.match(output, /workflow-process-manager\.ts/);
});

test("status collapses completed workflow boundaries and keeps recent facts", () => {
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
            capability: "general",
          },
        },
        children: [],
      },
    ],
  };
  const base = {
    tree: {
      root: {
        run: snapshot(ROOT, undefined, "root.session"),
        children: [workflow],
      },
    },
    facts: [
      factFor(scoutId, 1, "2026-07-24T00:00:10.000Z", "run-state-changed", "Older fact"),
      factFor(scoutId, 2, "2026-07-24T00:00:20.000Z", "child-finished", "Completed scout"),
      factFor(workflowId, 3, "2026-07-24T00:00:30.000Z", "child-finished", "Completed qa"),
      factFor(workflowId, 4, "2026-07-24T00:00:40.000Z", "child-finished", "Completed qa"),
      factFor(workflowId, 5, "2026-07-24T00:00:50.000Z", "test-result", "Latest fact"),
    ],
    sequence: 20,
    profile: { agent: "base" as const, modelSet: "mixed" as const, difficulty: "D2" as const },
    diagnostics: {
      total: 12,
      artifacts: 2,
      counts: { trace: 5, info: 4, warning: 2, error: 1 },
    },
    integrations: "5/6 loaded; failed: mcp",
    integrationsFailed: true,
  };

  const collapsed = renderDashboard({ ...base, expanded: false }).join("\n");
  assert.match(collapsed, /workflow qa · completed/);
  assert.match(collapsed, /1 descendants/);
  assert.doesNotMatch(collapsed, /opencode-go\/model-a/);
  assert.doesNotMatch(collapsed, /root\.session/);
  assert.match(collapsed, /Recent facts/);
  assert.equal((collapsed.match(/Completed qa/g) ?? []).length, 1);
  assert.match(collapsed, /Latest fact/);
  assert.doesNotMatch(collapsed, /Older fact/);
  assert.doesNotMatch(collapsed, /Storage/);

  const expanded = renderDashboard({ ...base, expanded: true }).join("\n");
  assert.match(expanded, /scout ·/);
  assert.match(expanded, /opencode-go\/model-a · low/);
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
  sequence: number,
  timestamp: string,
  kind: RunFact["kind"],
  summary: string,
): RunFact {
  return {
    id: `fact-${sequence}`,
    rootRunId: ROOT,
    runId: id,
    sequence,
    timestamp,
    kind,
    source: "runtime",
    summary,
    provenance: {},
    reliability: "observed",
  };
}
