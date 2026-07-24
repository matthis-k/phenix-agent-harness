import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileAgentMarkdown } from "../adapters/agent/markdown.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import type { AgentDefinition } from "../domain/definition/definition.ts";

const sources = [
  ["scout", "agent.scout"],
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
  ["qa-synthesizer", "agent.qa-synthesizer"],
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

test("agent contracts and effective permissions are explicit", () => {
  const byId = new Map(
    agentDefinitions.map((definition) => [String(definition.id), definition] as const),
  );
  const scout = byId.get("agent.scout");
  assert.ok(scout);
  assert.equal(scout.input.id, "request.scout.v1");
  assert.equal(scout.output.id, "outcome.scout-report.v1");
  assert.deepEqual(scout.tools.allow, ["read", "grep", "find", "ls", "phenix_present"]);
  assert.equal(scout.context.maxBytes, 64_000);
  assert.match(scout.prompt.render(), /insufficient_permissions/);

  const implementer = byId.get("agent.implementer");
  assert.ok(implementer);
  assert.ok(implementer.tools.allow.includes("edit"));
  assert.ok(implementer.tools.allow.includes("nix_shell"));
  assert.equal(implementer.input.id, "request.implementation.v1");
  assert.equal(implementer.output.id, "outcome.change-set.v1");
});

test("agent Markdown fails closed on unknown schemas", () => {
  assert.throws(
    () =>
      compileAgentMarkdown(source("scout").replace("request.scout.v1", "request.missing.v1"), {
        resolveSchema: resolveDefinitionSchema,
      }),
    /Unknown definition schema request.missing.v1/,
  );
});
