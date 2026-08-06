import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileAgentMarkdown } from "../adapters/agent/markdown.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";

const scout = readFileSync(
  new URL("../definitions/agents/sources/scout.agent.md", import.meta.url),
  "utf8",
);

test("agent markdown preserves backend/provider/model selectors", () => {
  const definition = compileAgentMarkdown(
    scout.replace("model: session", "model: claude/anthropic/sonnet"),
    { resolveSchema: resolveDefinitionSchema },
  );

  assert.deepEqual(definition.model, {
    kind: "target",
    backend: "claude",
    provider: "anthropic",
    model: "sonnet",
  });
});

test("legacy provider/model selectors remain backend-unqualified", () => {
  const definition = compileAgentMarkdown(
    scout.replace("model: session", "model: anthropic/sonnet"),
    { resolveSchema: resolveDefinitionSchema },
  );

  assert.deepEqual(definition.model, {
    kind: "concrete",
    provider: "anthropic",
    model: "sonnet",
  });
});
