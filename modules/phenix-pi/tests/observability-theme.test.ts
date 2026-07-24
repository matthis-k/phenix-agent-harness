import assert from "node:assert/strict";
import test from "node:test";

import type { RunTreeNode } from "../application/interfaces.ts";
import type { RunSnapshot, RunState } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import { definitionId, runId } from "../domain/shared.ts";
import { type ObservabilityTheme, statusLine } from "../extension/observability-theme.ts";
import { renderCompleteFactHistory, renderFacts, renderRuns } from "../extension/run-monitor.ts";

const ROOT = runId("root-colors");
const THEME = {
  fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
} as unknown as ObservabilityTheme;

test("status dashboard uses semantic state and activity colors", () => {
  const children: RunTreeNode[] = [
    node("completed", "agent.scout"),
    node("failed", "agent.tester"),
    node("waiting", "workflow.qa"),
    node("cancelled", "agent.critic"),
  ];
  const lines = renderRuns(
    {
      root: {
        run: snapshot(ROOT, undefined, "root.session", "running"),
        children,
      },
    },
    [],
    42,
    THEME,
  );
  const output = lines.join("\n");

  assert.match(output, /<accent><bold>Phenix · live status · seq 42<\/bold><\/accent>/);
  assert.match(output, /<accent><bold>Session<\/bold><\/accent>/);
  assert.match(output, /<accent><bold>Execution<\/bold><\/accent>/);
  assert.match(output, /<success>✓<\/success>.*<success>\[completed\]<\/success>/);
  assert.match(output, /<error>✗<\/error>.*<error>\[failed\]<\/error>/);
  assert.match(output, /<warning>○<\/warning>.*<warning>\[waiting\]<\/warning>/);
  assert.match(output, /<muted>−<\/muted>.*<muted>\[cancelled\]<\/muted>/);
  assert.match(output, /<dim>\/phenix status off · \/phenix status/);
});

test("fact history highlights severity, reliability, timestamps, and run ids", () => {
  const lines = renderFacts(
    [
      factItem("error-observed", "observed", "Tool failed"),
      factItem("test-result", "derived", "Checks passed"),
      factItem("finding-reported", "reported", "Potential boundary issue"),
    ],
    9,
    THEME,
  );
  const output = lines.join("\n");

  assert.match(output, /<dim>12:34:56<\/dim>/);
  assert.match(output, /<success>✓<\/success>/);
  assert.match(output, /<accent>≈<\/accent>/);
  assert.match(output, /<warning>!<\/warning>/);
  assert.match(output, /<muted>run-color<\/muted>/);
  assert.match(output, /<error>Tool failed<\/error>/);
  assert.match(output, /<success>Checks passed<\/success>/);
  assert.match(output, /<warning>Potential boundary issue<\/warning>/);
});

test("footer status distinguishes active work from idle", () => {
  const active = statusLine(THEME, { agent: "base", modelSet: "mixed", difficulty: "D2" }, 3);
  const idle = statusLine(THEME, { agent: "base", modelSet: "mixed", difficulty: "D2" }, 0);

  assert.match(active, /<accent><bold>phenix<\/bold><\/accent>/);
  assert.match(active, /<text><bold>base<\/bold><\/text>/);
  assert.match(active, /<accent>mixed<\/accent>/);
  assert.match(active, /<warning>3 active<\/warning>/);
  assert.match(idle, /<success>idle<\/success>/);
});

test("complete fact export remains plain text", () => {
  const output = renderCompleteFactHistory(
    [factItem("error-observed", "observed", "Tool failed")],
    1,
  );

  assert.equal(output.includes("<error>"), false);
  assert.equal(output.includes("\u001b["), false);
  assert.match(output, /12:34:56 ✓ run-color · Tool failed/);
});

function node(state: RunState, definition: string): RunTreeNode {
  return {
    run: snapshot(runId(`run-${state}`), ROOT, definition, state),
    children: [],
  };
}

function snapshot(
  id: ReturnType<typeof runId>,
  parentId: ReturnType<typeof runId> | undefined,
  definition: string,
  state: RunState,
): RunSnapshot {
  const resolvedDefinition = definitionId(definition);
  return {
    id,
    ...(parentId ? { parentId } : {}),
    kind: parentId ? (definition.startsWith("workflow.") ? "workflow" : "agent") : "root",
    definitionId: resolvedDefinition,
    input: {},
    outputSchemaId: "test.output",
    requestedAt: "2026-07-24T00:00:00.000Z",
    ownership: "attached",
    state,
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

function factItem(
  kind: RunFact["kind"],
  reliability: RunFact["reliability"],
  summary: string,
): RunFact {
  return {
    id: `${kind}-${reliability}`,
    rootRunId: ROOT,
    runId: runId("run-color"),
    sequence: 1,
    timestamp: "2026-07-24T12:34:56.000Z",
    kind,
    source: reliability === "reported" ? "agent-report" : "runtime",
    summary,
    subject: "subject.ts",
    provenance: {},
    reliability,
  };
}
