import assert from "node:assert/strict";
import test from "node:test";

import { agentDefinitions } from "../definitions/agents.ts";
import { WORKFLOW_QA } from "../definitions/ids.ts";
import type { QAReport, TestRequest } from "../definitions/schemas.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("QA keeps command obligations out of read-only review branches", async () => {
  const inputs = new Map<string, unknown>();
  let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
  runtime = await createTestRuntime({
    async start(command) {
      const definitionId = String(command.definition.id);
      inputs.set(definitionId, command.input);
      await runtime.controller.transition(command.runId, "starting");
      await runtime.controller.transition(command.runId, "running");

      if (definitionId === "agent.scout") {
        await runtime.controller.complete(command.runId, {
          summary: "repository reviewed",
          evidence: [],
          risks: [],
        });
        return;
      }
      if (definitionId === "agent.tester") {
        const input = command.input as TestRequest;
        await runtime.controller.complete(command.runId, {
          summary: "checks interpreted",
          checks: input.checks,
          findings: [],
          evidence: [],
        });
        return;
      }
      if (definitionId === "agent.architect" || definitionId === "agent.critic") {
        await runtime.controller.complete(command.runId, {
          summary: "reviewed",
          findings: [],
        });
        return;
      }
      assert.equal(definitionId, "agent.qa-synthesizer");
      await runtime.controller.complete(command.runId, {
        summary: "QA complete",
        findings: [],
        reports: [],
      });
    },
  });

  const objective =
    "Run devenv tasks run maintenance:fix and devenv test, then review architecture and security.";
  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef<unknown, QAReport>(WORKFLOW_QA),
    input: { objective },
    wait: "await",
  });

  assert.equal((await handle.result()).status, "success");

  const scout = inputs.get("agent.scout") as { objective: string; focus: string };
  assert.match(scout.objective, /Perform only the repository structure/);
  assert.match(scout.objective, /Do not execute or delegate commands/);
  assert.match(scout.objective, /background context, not an execution instruction/);
  assert.equal(scout.focus, "repository structure, correctness, and maintainability");

  const architect = inputs.get("agent.architect") as { objective: string };
  assert.match(architect.objective, /Remain read-only/);
  assert.match(architect.objective, /Do not run or delegate/);

  const security = inputs.get("agent.critic") as { objective: string };
  assert.match(security.objective, /baseline command execution as already owned/);

  const tester = inputs.get("agent.tester") as TestRequest;
  assert.equal(tester.objective, objective);
});

test("difficulty estimation permits one correction turn", () => {
  const estimator = agentDefinitions.find(
    (definition) => definition.id === "agent.difficulty-estimator",
  );
  assert.ok(estimator);
  assert.equal(estimator.limits.maxTurns, 2);
});
