import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createVisualizationPublisherExtension } from "../adapters/pi-sdk/visualization-publisher.ts";
import {
  createVisualizationArtifact,
  isVisualizationArtifact,
  VISUALIZATION_EVENT,
} from "../domain/presentation/visualization.ts";

const request = {
  title: "Runtime boundaries",
  summary: "Shows ownership and dependency direction.",
  source: "flowchart LR\n  UI --> Application\n  Application --> Domain",
};

test("visual artifacts are normalized, validated, and stable", () => {
  const left = createVisualizationArtifact({ ...request, sourceSessionId: "session-architect" });
  const right = createVisualizationArtifact({ ...request, sourceSessionId: "session-architect" });
  assert.equal(left.visualizationId, right.visualizationId);
  assert.match(left.visualizationId, /^visualization-[a-f0-9]{16}$/);
  assert.equal(left.renderer, "beautiful-mermaid");
  assert.equal(isVisualizationArtifact(left), true);
  assert.throws(
    () =>
      createVisualizationArtifact({
        ...request,
        source: "pie\n  title Unsupported",
        sourceSessionId: "session-architect",
      }),
    /Unsupported Mermaid diagram/,
  );
});

test("managed child sessions publish diagrams without returning source or rendered output", async () => {
  let sessionStart:
    | ((event: unknown, context: { sessionManager: { getSessionId(): string } }) => void)
    | undefined;
  let tool: ToolDefinition | undefined;
  const emitted: Array<{ readonly name: string; readonly value: unknown }> = [];
  const pi = {
    on(name: string, handler: typeof sessionStart) {
      if (name === "session_start") sessionStart = handler;
    },
    registerTool(candidate: ToolDefinition) {
      tool = candidate;
    },
    events: {
      emit(name: string, value: unknown) {
        emitted.push({ name, value });
      },
    },
  } as unknown as ExtensionAPI;

  createVisualizationPublisherExtension()(pi);
  assert.ok(sessionStart);
  sessionStart({}, { sessionManager: { getSessionId: () => "session-architect" } });
  assert.ok(tool);

  const first = await tool.execute("call-1", request, new AbortController().signal);
  const second = await tool.execute("call-2", request, new AbortController().signal);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.name, VISUALIZATION_EVENT);
  assert.equal(isVisualizationArtifact(emitted[0]?.value), true);
  assert.deepEqual(first, { content: [{ type: "text", text: "Visual accepted." }] });
  assert.deepEqual(second, { content: [{ type: "text", text: "Visual accepted." }] });
  assert.doesNotMatch(JSON.stringify(first), /flowchart|visualization-|Open with|Beautiful Mermaid/);
});
