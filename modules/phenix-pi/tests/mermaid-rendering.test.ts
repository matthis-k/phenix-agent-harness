import assert from "node:assert/strict";
import test from "node:test";

import type { RunTree } from "../application/interfaces.ts";
import type { WorkflowDefinition } from "../domain/definition/definition.ts";
import {
  renderTerminalMermaid,
  runTreeSequenceMermaid,
  workflowDefinitionMermaid,
} from "../extension/mermaid-rendering.ts";

test("terminal Mermaid rendering supports flowcharts and sequence diagrams", () => {
  const flowchart = renderTerminalMermaid("flowchart LR\n  A[Start] --> B[Done]", {
    compact: true,
  });
  const sequence = renderTerminalMermaid(
    "sequenceDiagram\n  participant A as Root\n  participant B as Scout\n  A->>B: inspect",
    { compact: true },
  );
  assert.match(flowchart, /Start/);
  assert.match(flowchart, /Done/);
  assert.match(sequence, /Root/);
  assert.match(sequence, /Scout/);
});

test("workflow definitions compile to flowcharts from the executable graph", () => {
  const definition = {
    id: "workflow.sample",
    kind: "workflow",
    title: "Sample",
    description: "Sample workflow",
    input: { id: "input.sample" },
    output: { id: "output.sample" },
    graph: {
      entry: "scout",
      nodes: [
        {
          kind: "invoke",
          id: "scout",
          title: "Scout",
          definition: { id: "agent.scout" },
          input: "sample.input",
          wait: "await",
        },
        { kind: "return", id: "done", title: "Done", output: "sample.output" },
      ],
      edges: [{ from: "scout", to: "done" }],
    },
    limits: { timeoutMs: 1_000, maxNodeRuns: 2, maxParallelism: 1 },
  } as unknown as WorkflowDefinition<unknown, unknown>;

  const source = workflowDefinitionMermaid(definition);
  assert.match(source, /^flowchart TD/m);
  assert.match(source, /agent\.scout/);
  assert.match(source, /entry --> n0/);
  assert.match(source, /n0 --> n1/);
});

test("run trees become sequence diagrams with workflow boundaries", () => {
  const tree = {
    root: {
      run: { id: "root-test", kind: "root", definitionId: "root.session", state: "running" },
      children: [
        {
          run: {
            id: "run-workflow",
            kind: "workflow",
            definitionId: "workflow.qa",
            state: "running",
          },
          children: [
            {
              run: {
                id: "run-agent",
                kind: "agent",
                definitionId: "agent.architect",
                state: "running",
                resolvedModel: {
                  concrete: { provider: "test", model: "model-a" },
                  thinking: "high",
                },
              },
              children: [],
            },
          ],
        },
      ],
    },
  } as unknown as RunTree;

  const source = runTreeSequenceMermaid(tree);
  assert.match(source, /rect workflow qa · running/);
  assert.match(source, /participant p1 as architect/);
  assert.match(source, /p0->>p1: start · running/);
});
