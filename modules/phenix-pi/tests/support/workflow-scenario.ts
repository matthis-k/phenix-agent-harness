import assert from "node:assert/strict";
import type {
  WorkflowMockAction,
  WorkflowScenario,
} from "../../adapters/workflow/scenario-markdown.ts";
import type {
  RunImplementation,
  StartImplementationCommand,
} from "../../application/execution-facade.ts";
import {
  type AnyDefinition,
  definitionRef,
  type WorkflowDefinition,
} from "../../domain/definition/definition.ts";
import { definitionId, type Outcome } from "../../domain/shared.ts";
import type { LocalOperationRunner } from "../../ports/local-operation-runner.ts";
import { createTestRuntime, type TestRuntime } from "./core-runtime.ts";

export interface WorkflowScenarioResult {
  readonly outcome: Outcome<unknown>;
  readonly visits: readonly string[];
  readonly transitions: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

export async function runWorkflowScenario(
  workflow: WorkflowDefinition<unknown, unknown>,
  scenario: WorkflowScenario,
  additionalDefinitions: readonly AnyDefinition[] = [],
): Promise<WorkflowScenarioResult> {
  const scripts = new ScenarioScripts(scenario);
  let runtime: TestRuntime;
  const implementation: RunImplementation = {
    async start(command) {
      const parent = runtime.store.projection.requireRun(command.parentId);
      if (parent.definitionId === workflow.id) {
        await executeScriptedAgent(runtime, command, scripts);
        return;
      }
      await executeNestedWorkflowAgent(runtime, command, scripts);
    },
  };
  const operations = scenarioOperations(workflow, scripts);
  runtime = await createTestRuntime(implementation, {
    definitions: additionalDefinitions,
    operations,
  });

  const handle = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(definitionId(workflow.id)),
    input: scenario.input,
    wait: "await",
  });
  const outcome = await handle.result();
  const events = runtime.store.projection.eventsFor(handle.id);
  const visits = events
    .filter((event) => event.type === "workflow.node.entered")
    .map((event) => (event.data as { readonly nodeId: string }).nodeId);
  const transitions = events
    .filter((event) => event.type === "workflow.transition.taken")
    .map((event) => {
      const data = event.data as { readonly from: string; readonly to: string };
      return `${data.from}->${data.to}`;
    });
  const counts = Object.fromEntries(
    [...new Set(visits)].map((nodeId) => [
      nodeId,
      visits.filter((visit) => visit === nodeId).length,
    ]),
  );
  const result = { outcome, visits, transitions, counts };
  assertScenario(workflow, scenario, scripts, result);
  return result;
}

class ScenarioScripts {
  private readonly scenario: WorkflowScenario;
  private readonly consumed = new Map<string, number>();

  constructor(scenario: WorkflowScenario) {
    this.scenario = scenario;
  }

  availableTools(): ReadonlySet<string> | undefined {
    const available = this.scenario.environment.availableTools;
    return available ? new Set(available) : undefined;
  }

  next(nodeId: string): WorkflowMockAction {
    const index = this.consumed.get(nodeId) ?? 0;
    const action = this.scenario.mocks[nodeId]?.[index];
    if (!action)
      throw new Error(`No mock action ${index + 1} configured for workflow state ${nodeId}`);
    this.consumed.set(nodeId, index + 1);
    return action;
  }

  assertConsumed(): void {
    for (const [nodeId, actions] of Object.entries(this.scenario.mocks)) {
      const consumed = this.consumed.get(nodeId) ?? 0;
      assert.equal(
        consumed,
        actions.length,
        `Workflow test ${this.scenario.id} consumed ${consumed}/${actions.length} mocks for ${nodeId}`,
      );
    }
  }
}

async function executeScriptedAgent(
  runtime: TestRuntime,
  command: StartImplementationCommand,
  scripts: ScenarioScripts,
): Promise<void> {
  const run = runtime.store.projection.requireRun(command.runId);
  const nodeId = run.compiled.invocation.causation?.nodeId ?? command.definition.id;
  if (!(await startAgent(runtime, command, scripts, nodeId))) return;

  const action = scripts.next(nodeId);
  if ("return" in action) {
    await runtime.controller.complete(command.runId, action.return);
    return;
  }
  if ("fail" in action) {
    await runtime.controller.fail(command.runId, action.fail);
    return;
  }
  await runtime.execution.cancel(command.runId, action.cancel);
}

async function executeNestedWorkflowAgent(
  runtime: TestRuntime,
  command: StartImplementationCommand,
  scripts: ScenarioScripts,
): Promise<void> {
  const nodeId = command.definition.id;
  if (!(await startAgent(runtime, command, scripts, nodeId))) return;
  await runtime.controller.complete(
    command.runId,
    deterministicOutput(command.definition, command.input),
  );
}

async function startAgent(
  runtime: TestRuntime,
  command: StartImplementationCommand,
  scripts: ScenarioScripts,
  nodeId: string,
): Promise<boolean> {
  await runtime.controller.transition(command.runId, "starting");
  await runtime.controller.transition(command.runId, "running");

  const available = scripts.availableTools();
  if (!available) return true;

  const required = command.definition.kind === "agent" ? command.definition.tools.allow : [];
  const missing = required.filter((tool) => !available.has(tool));
  if (missing.length === 0) return true;

  await runtime.controller.fail(command.runId, {
    code: "tool_unavailable",
    message: `State ${nodeId} cannot start ${command.definition.id}; unavailable tools: ${missing.join(", ")}`,
    retryable: false,
    details: {
      source: "workflow_scenario",
      definitionId: command.definition.id,
      nodeId,
      required,
      missing,
      available: [...available],
    },
  });
  return false;
}

function deterministicOutput(definition: AnyDefinition, input: unknown): unknown {
  switch (definition.output.id) {
    case "outcome.difficulty-assessment":
      return {
        difficulty: "D1",
        summary: "Deterministic nested-workflow assessment",
        signals: ["workflow scenario"],
      };
    case "outcome.plan":
      return { summary: "plan", steps: ["edit"], constraints: [], checks: ["test"] };
    case "outcome.change-set":
      return {
        summary: "implemented",
        changedFiles: ["src/file.ts"],
        checks: [{ command: "test", ok: true, summary: "passed" }],
        unresolved: [],
      };
    case "outcome.verification":
      return { accepted: true, summary: "accepted", findings: [], evidence: ["tests pass"] };
    case "outcome.scout-report":
      return {
        summary: "scouted",
        evidence: [{ path: "src/file.ts", finding: "ok" }],
        risks: [],
      };
    case "outcome.test-report":
      return {
        summary: "checks passed",
        checks: [{ command: "test", ok: true, summary: "passed" }],
        findings: [],
        evidence: ["test passed"],
      };
    case "outcome.critic-report":
      return { summary: "reviewed", findings: [] };
    case "outcome.qa-report":
      return {
        summary: "clean",
        checks: [{ command: "test", ok: true, summary: "passed" }],
        findings: [],
        reports: [],
      };
    case "outcome.base":
      return { summary: "done", artifacts: [], unresolved: [] };
    case "outcome.stock-session-handoff": {
      if (typeof input !== "object" || input === null || !("outputSchema" in input)) {
        throw new Error("Nested stock scenario requires outputSchema");
      }
      return {
        outputSchema: input.outputSchema,
        value: {
          summary: "stock result",
          evidence: [{ path: "src/file.ts", finding: "stock evidence" }],
          risks: [],
        },
      };
    }
    default:
      throw new Error(
        `No deterministic nested-workflow output for ${definition.id} (${definition.output.id})`,
      );
  }
}

function scenarioOperations(
  workflow: WorkflowDefinition<unknown, unknown>,
  scripts: ScenarioScripts,
): LocalOperationRunner {
  const operationOwners = new Map<string, string>();
  for (const node of workflow.graph.nodes) {
    if (node.kind !== "local") continue;
    if (operationOwners.has(node.operation)) {
      throw new Error(
        `Workflow scenario runner cannot disambiguate repeated local operation ${node.operation}; use distinct operation IDs`,
      );
    }
    operationOwners.set(node.operation, node.id);
  }
  return {
    has: (operation) => operationOwners.has(operation),
    async run(operation) {
      const nodeId = operationOwners.get(operation);
      if (!nodeId) throw new Error(`No scenario local operation ${operation}`);
      const action = scripts.next(nodeId);
      if ("return" in action) return action.return;
      if ("fail" in action) throw new Error(`${action.fail.code}: ${action.fail.message}`);
      throw new Error(`Local operation ${nodeId} cannot be cancelled by a scenario mock`);
    },
  };
}

function assertScenario(
  workflow: WorkflowDefinition<unknown, unknown>,
  scenario: WorkflowScenario,
  scripts: ScenarioScripts,
  result: WorkflowScenarioResult,
): void {
  assert.equal(
    result.outcome.status,
    scenario.expect.status,
    `${workflow.id}/${scenario.id} terminal status; outcome=${JSON.stringify(result.outcome)}`,
  );
  if (scenario.expect.visits) {
    assert.deepEqual(result.visits, scenario.expect.visits, `${workflow.id}/${scenario.id} visits`);
  }
  for (const [nodeId, expected] of Object.entries(scenario.expect.counts ?? {})) {
    assert.equal(
      result.counts[nodeId] ?? 0,
      expected,
      `${workflow.id}/${scenario.id} count ${nodeId}`,
    );
  }
  if (scenario.expect.transitions) {
    assert.deepEqual(
      result.transitions,
      scenario.expect.transitions,
      `${workflow.id}/${scenario.id} transitions`,
    );
  }
  if (scenario.expect.failure) {
    assert.equal(
      result.outcome.status,
      "failure",
      `${workflow.id}/${scenario.id} expected failure`,
    );
    if (result.outcome.status === "failure") {
      if (scenario.expect.failure.code) {
        assert.equal(result.outcome.failure.code, scenario.expect.failure.code);
      }
      if (scenario.expect.failure.messageIncludes) {
        assert.match(
          result.outcome.failure.message,
          new RegExp(escapeRegExp(scenario.expect.failure.messageIncludes)),
        );
      }
    }
  }
  if (scenario.expect.requireAllMocksConsumed) scripts.assertConsumed();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
