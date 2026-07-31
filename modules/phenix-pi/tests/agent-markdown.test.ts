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
  assert.deepEqual(scout.tools.allow, [
    "read",
    "grep",
    "find",
    "ls",
    "phenix_project",
    "phenix_userform",
    "phenix_present",
  ]);
  assert.equal(scout.context.maxBytes, 64_000);
  assert.equal(scout.modelRoutes?.D0.capability, "fast");
  assert.equal(scout.modelRoutes?.D3.capability, "reasoning");
  assert.equal(scout.promptMode, undefined);
  assert.match(scout.prompt.render(), /insufficient_permissions/);

  const planner = byId.get("agent.planner");
  const architect = byId.get("agent.architect");
  assert.ok(planner);
  assert.ok(architect);
  assert.ok(planner.tools.allow.includes("phenix_project"));
  assert.ok(planner.tools.allow.includes("phenix_userform"));
  assert.ok(planner.tools.allow.includes("phenix_visualize"));
  assert.ok(architect.tools.allow.includes("phenix_userform"));
  assert.ok(architect.tools.allow.includes("phenix_visualize"));
  assert.match(planner.prompt.render(), /mark that section for UI rendering/);
  assert.match(architect.prompt.render(), /mark that section for UI rendering/);
  assert.match(planner.prompt.render(), /Do not include the Mermaid source/);
  assert.match(architect.prompt.render(), /Do not include the Mermaid source/);

  const implementer = byId.get("agent.implementer");
  assert.ok(implementer);
  assert.ok(implementer.tools.allow.includes("edit"));
  assert.ok(implementer.tools.allow.includes("phenix_project"));
  assert.ok(implementer.tools.allow.includes("phenix_userform"));
  assert.ok(implementer.tools.allow.includes("nix_shell"));
  assert.equal(implementer.input.id, "request.implementation");
  assert.equal(implementer.output.id, "outcome.change-set");
  assert.equal(implementer.modelRoutes?.D0.capability, "code-fast");
  assert.equal(implementer.modelRoutes?.D3.capability, "code-max");
  assert.equal(implementer.promptMode, "append-default");

  const base = byId.get("agent.base");
  assert.ok(base);
  assert.ok(base.tools.allow.includes("phenix_userform"));
  assert.equal(base.promptMode, "append-default");

  const coordinator = byId.get("agent.coordinator");
  assert.ok(coordinator);
  assert.equal(coordinator.input.id, "request.dynamic-workflow-composition");
  assert.equal(coordinator.output.id, "request.dynamic-workflow-proposal");
  assert.deepEqual(coordinator.tools.allow, []);
  assert.equal(coordinator.context.projectFiles, "none");
  assert.equal(coordinator.limits.timeoutMs, 600_000);
  assert.equal(coordinator.limits.maxTurns, undefined);
  assert.equal(coordinator.limits.maxToolCalls, undefined);
  assert.equal(coordinator.promptMode, undefined);
  assert.match(coordinator.prompt.render(), /declarative workflow composer/);

  const stock = byId.get("session.stock");
  assert.ok(stock);
  assert.equal(stock.sessionMode, "stock");
  assert.equal(stock.promptMode, undefined);
  assert.equal(stock.input.id, "request.stock-session");
  assert.equal(stock.output.id, "outcome.stock-session-handoff");
  assert.deepEqual(stock.tools.allow, []);
  assert.deepEqual(stock.childCapabilities.invokableDefinitions, []);
  assert.equal(stock.persistence, "file");
  assert.equal(stock.prompt.render(), "PHENIX_STOCK_SESSION");
});
