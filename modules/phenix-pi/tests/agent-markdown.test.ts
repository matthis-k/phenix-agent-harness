import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileAgentMarkdown } from "../adapters/agent/markdown.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import type { AgentDefinition } from "../domain/definition/definition.ts";

const sources = [
  ["difficulty-estimator", "agent.difficulty-estimator"],
  ["scout", "agent.scout"],
  ["reproducer", "agent.reproducer"],
  ["researcher", "agent.researcher"],
  ["threat-modeler", "agent.threat-modeler"],
  ["planner", "agent.planner"],
  ["architect", "agent.architect"],
  ["implementer", "agent.implementer"],
  ["tester", "agent.tester"],
  ["verifier", "agent.verifier"],
  ["critic", "agent.critic"],
  ["finalizer", "agent.finalizer"],
  ["dispatcher", "agent.dispatcher"],
  ["coordinator", "agent.coordinator"],
  ["base", "agent.base"],
  ["stock", "session.stock"],
  ["qa-synthesizer", "agent.qa-synthesizer"],
  ["attention-router", "agent.attention-router"],
] as const;

function source(name: string): string {
  return readFileSync(
    new URL(`../definitions/agents/sources/${name}.agent.md`, import.meta.url),
    "utf8",
  );
}

function snapshot(definition: AgentDefinition<unknown, unknown>) {
  return {
    ...definition,
    input: definition.input.id,
    output: definition.output.id,
    prompt: definition.prompt.render(),
  };
}

test("every bundled agent is loaded from its Markdown source", () => {
  const production = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  assert.equal(production.size, sources.length);

  for (const [name, id] of sources) {
    const compiled = compileAgentMarkdown(source(name), {
      resolveSchema: resolveDefinitionSchema,
    });
    const registered = production.get(id);
    assert.ok(registered, id);
    assert.deepEqual(snapshot(compiled), snapshot(registered));
  }
});

test("agent contracts, routes, and effective permissions are explicit", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  const estimator = byId.get("agent.difficulty-estimator");
  assert.ok(estimator);
  assert.equal(estimator.input.id, "request.difficulty-assessment");
  assert.equal(estimator.output.id, "outcome.difficulty-assessment");
  assert.deepEqual(estimator.tools.allow, []);
  assert.equal(estimator.modelRoutes?.D3.capability, "general");
  assert.match(estimator.prompt.render(), /flowchart TD/);

  const scout = byId.get("agent.scout");
  assert.ok(scout);
  assert.equal(scout.input.id, "request.scout");
  assert.equal(scout.output.id, "outcome.scout-report");
  assert.deepEqual(scout.tools.allow, ["read", "grep", "find", "ls", "phenix_present"]);
  assert.equal(scout.context.maxBytes, 64_000);
  assert.equal(scout.modelRoutes?.D0.capability, "fast");
  assert.equal(scout.modelRoutes?.D3.capability, "reasoning");
  assert.equal(scout.promptMode, undefined);

  const stock = byId.get("session.stock");
  assert.ok(stock);
  assert.equal(stock.sessionMode, "stock");
  assert.equal(stock.input.id, "request.stock-session");
  assert.equal(stock.output.id, "outcome.stock-session-handoff");
  assert.deepEqual(stock.tools.allow, []);
  assert.equal(stock.promptMode, "default-only");
});
