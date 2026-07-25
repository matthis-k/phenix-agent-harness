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
  ["generic-read", "agent.generic-read"],
  ["generic-write", "agent.generic-write"],
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
  assert.equal(estimator.input.id, "request.difficulty-assessment.v1");
  assert.equal(estimator.output.id, "outcome.difficulty-assessment.v1");
  assert.deepEqual(estimator.tools.allow, []);
  assert.equal(estimator.modelRoutes?.D3.capability, "general");
  assert.match(estimator.prompt.render(), /flowchart TD/);

  const scout = byId.get("agent.scout");
  assert.ok(scout);
  assert.equal(scout.input.id, "request.scout.v1");
  assert.equal(scout.output.id, "outcome.scout-report.v1");
  assert.deepEqual(scout.tools.allow, ["read", "grep", "find", "ls", "phenix_present"]);
  assert.equal(scout.context.maxBytes, 64_000);
  assert.equal(scout.modelRoutes?.D0.capability, "fast");
  assert.equal(scout.modelRoutes?.D3.capability, "reasoning");
  assert.match(scout.prompt.render(), /insufficient_permissions/);

  const implementer = byId.get("agent.implementer");
  assert.ok(implementer);
  assert.ok(implementer.tools.allow.includes("edit"));
  assert.ok(implementer.tools.allow.includes("nix_shell"));
  assert.equal(implementer.input.id, "request.implementation.v1");
  assert.equal(implementer.output.id, "outcome.change-set.v1");
  assert.equal(implementer.modelRoutes?.D0.capability, "code-fast");
  assert.equal(implementer.modelRoutes?.D3.capability, "code-max");

  const coordinator = byId.get("agent.coordinator");
  assert.ok(coordinator);
  assert.equal(coordinator.input.id, "request.dynamic-workflow-composition.v1");
  assert.equal(coordinator.output.id, "request.dynamic-workflow-proposal.v1");
  assert.deepEqual(coordinator.tools.allow, []);
  assert.equal(coordinator.context.projectFiles, "none");
  assert.equal(coordinator.limits.timeoutMs, 600_000);
  assert.equal(coordinator.limits.maxTurns, undefined);
  assert.equal(coordinator.limits.maxToolCalls, undefined);
  assert.match(coordinator.prompt.render(), /declarative workflow composer/);

  const genericRead = byId.get("agent.generic-read");
  const genericWrite = byId.get("agent.generic-write");
  assert.ok(genericRead);
  assert.ok(genericWrite);
  assert.equal(genericRead.input.id, "request.generic-task.v1");
  assert.equal(genericWrite.input.id, "request.generic-task.v1");
  assert.equal(genericRead.output.id, "outcome.base.v1");
  assert.equal(genericWrite.output.id, "outcome.base.v1");
  assert.deepEqual(genericRead.childCapabilities.invokableDefinitions, []);
  assert.deepEqual(genericWrite.childCapabilities.invokableDefinitions, []);
  assert.deepEqual(genericRead.tools.allow, [
    "read",
    "grep",
    "find",
    "ls",
    "phenix_tasks",
    "phenix_present",
  ]);
  assert.ok(genericWrite.tools.allow.includes("edit"));
  assert.ok(genericWrite.tools.allow.includes("bash"));
  assert.ok(genericWrite.tools.allow.includes("nix_shell"));
  assert.equal(genericRead.tools.allow.includes("edit"), false);
  assert.equal(genericRead.tools.allow.includes("bash"), false);
  assert.equal(genericRead.modelRoutes?.D3.capability, "reasoning");
  assert.equal(genericWrite.modelRoutes?.D3.capability, "code-max");

  const attentionRouter = byId.get("agent.attention-router");
  assert.ok(attentionRouter);
  assert.equal(attentionRouter.input.id, "attention.routing-request");
  assert.equal(attentionRouter.output.id, "attention.routing-decision");
  assert.deepEqual(attentionRouter.tools.allow, []);
});

test("agent Markdown requires a complete difficulty model table", () => {
  const incomplete = source("implementer").replace(
    "| `D3` | `session` | `code-max` | `high` |\n",
    "",
  );
  assert.throws(
    () => compileAgentMarkdown(incomplete, { resolveSchema: resolveDefinitionSchema }),
    /agent Models is missing D3/,
  );
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
