import type { WorkflowDefinition, WorkflowNode } from "../../domain/definition/definition.ts";
import type { Failure, FailureCode } from "../../domain/shared.ts";
import {
  optionalMarkdownSection,
  requiredMarkdownFence,
} from "../definition/markdown.ts";
import {
  compileWorkflowMarkdown,
  parseWorkflowMarkdown,
  type WorkflowMarkdownBindings,
} from "./markdown.ts";

export type WorkflowMockAction =
  | { readonly return: unknown }
  | { readonly fail: Failure }
  | { readonly cancel: string };

export interface WorkflowScenarioEnvironment {
  readonly availableTools?: readonly string[];
}

export interface WorkflowScenarioExpectation {
  readonly status: "success" | "failure" | "cancelled";
  readonly visits?: readonly string[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly transitions?: readonly string[];
  readonly failure?: {
    readonly code?: FailureCode;
    readonly messageIncludes?: string;
  };
  readonly requireAllMocksConsumed: boolean;
}

export interface WorkflowScenario {
  readonly id: string;
  readonly input: unknown;
  readonly mocks: Readonly<Record<string, readonly WorkflowMockAction[]>>;
  readonly environment: WorkflowScenarioEnvironment;
  readonly expect: WorkflowScenarioExpectation;
}

const FAILURE_CODES = new Set<FailureCode>([
  "definition_not_found",
  "input_invalid",
  "model_unavailable",
  "backend_start_failed",
  "agent_reported_failure",
  "provider_failed",
  "timeout",
  "turn_budget_exceeded",
  "tool_budget_exceeded",
  "output_missing",
  "output_invalid",
  "workflow_invalid",
  "workflow_runtime_failed",
  "workflow_exhausted",
  "local_step_failed",
  "tool_unavailable",
  "cancelled",
  "orphaned",
]);

export function compileWorkflowMarkdownScenarios(
  source: string,
  bindings: WorkflowMarkdownBindings,
): readonly WorkflowScenario[] {
  const section = optionalMarkdownSection(source, "Tests");
  if (section === undefined) return [];

  const workflow = compileWorkflowMarkdown(source, bindings);
  const authored = parseWorkflowMarkdown(source);
  const authoredStates = new Map(authored.states.map((state) => [state.id, state]));
  const nodes = new Map(workflow.graph.nodes.map((node) => [node.id, node]));
  const headings = [...section.matchAll(/^###\s+([A-Za-z0-9._:-]+)\s*$/gm)];
  if (headings.length === 0) throw new Error(`${workflow.id} Tests section has no scenarios`);

  const seen = new Set<string>();
  return headings.map((heading, index) => {
    const id = heading[1];
    if (seen.has(id)) throw new Error(`${workflow.id} has duplicate test ${id}`);
    seen.add(id);
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? section.length;
    const body = section.slice(start, end);
    let raw: unknown;
    try {
      raw = JSON.parse(requiredMarkdownFence(body, "phenix-test"));
    } catch (error) {
      throw new Error(
        `${workflow.id} test ${id} has invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return compileScenario(id, raw, workflow, nodes, authoredStates, bindings);
  });
}

function compileScenario(
  id: string,
  raw: unknown,
  workflow: WorkflowDefinition<unknown, unknown>,
  nodes: ReadonlyMap<string, WorkflowNode>,
  authoredStates: ReadonlyMap<string, { readonly fields: Readonly<Record<string, string>> }>,
  bindings: WorkflowMarkdownBindings,
): WorkflowScenario {
  const owner = `${workflow.id} test ${id}`;
  const value = requireRecord(raw, owner);
  assertFields(value, ["input", "mocks", "environment", "expect"], owner);
  if (!("input" in value)) throw new Error(`${owner} requires input`);
  const input = workflow.input.validate(value.input);
  if (!input.ok) throw validationError(`${owner} input`, input.issues);

  const mocksValue = requireRecord(value.mocks ?? {}, `${owner}.mocks`);
  const mocks: Record<string, readonly WorkflowMockAction[]> = {};
  for (const [nodeId, rawActions] of Object.entries(mocksValue)) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`${owner}.mocks references unknown state ${nodeId}`);
    if (node.kind !== "invoke" && node.kind !== "local") {
      throw new Error(`${owner}.mocks state ${nodeId} must be invoke or local`);
    }
    if (!Array.isArray(rawActions) || rawActions.length === 0) {
      throw new Error(`${owner}.mocks.${nodeId} must be a non-empty array`);
    }
    mocks[nodeId] = rawActions.map((action, actionIndex) =>
      compileMockAction(
        action,
        `${owner}.mocks.${nodeId}[${actionIndex}]`,
        node,
        authoredStates.get(nodeId),
        bindings,
      ),
    );
  }

  const environmentValue = requireRecord(value.environment ?? {}, `${owner}.environment`);
  assertFields(environmentValue, ["availableTools"], `${owner}.environment`);
  const availableTools = optionalStringArray(
    environmentValue.availableTools,
    `${owner}.environment.availableTools`,
  );
  if (availableTools && new Set(availableTools).size !== availableTools.length) {
    throw new Error(`${owner}.environment.availableTools contains duplicates`);
  }

  const expectation = compileExpectation(value.expect, owner, workflow, nodes);
  return {
    id,
    input: input.value,
    mocks,
    environment: availableTools ? { availableTools } : {},
    expect: expectation,
  };
}

function compileMockAction(
  raw: unknown,
  owner: string,
  node: WorkflowNode,
  authored: { readonly fields: Readonly<Record<string, string>> } | undefined,
  bindings: WorkflowMarkdownBindings,
): WorkflowMockAction {
  const action = requireRecord(raw, owner);
  assertFields(action, ["return", "fail", "cancel"], owner);
  const kinds = ["return", "fail", "cancel"].filter((key) => key in action);
  if (kinds.length !== 1) throw new Error(`${owner} requires exactly one of return, fail, or cancel`);

  if ("return" in action) {
    const schema =
      node.kind === "invoke"
        ? bindings.resolveDefinition(node.definition.id).output
        : bindings.resolveSchema(requiredField(authored?.fields, "output-schema", owner));
    const validation = schema.validate(action.return);
    if (!validation.ok) throw validationError(`${owner}.return (${schema.id})`, validation.issues);
    return { return: validation.value };
  }
  if ("cancel" in action) {
    if (typeof action.cancel !== "string" || !action.cancel.trim()) {
      throw new Error(`${owner}.cancel must be a non-empty string`);
    }
    return { cancel: action.cancel };
  }
  return { fail: compileFailure(action.fail, `${owner}.fail`) };
}

function compileFailure(raw: unknown, owner: string): Failure {
  const value = requireRecord(raw, owner);
  assertFields(value, ["code", "message", "retryable", "details"], owner);
  if (typeof value.code !== "string" || !FAILURE_CODES.has(value.code as FailureCode)) {
    throw new Error(`${owner}.code is not a supported failure code`);
  }
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new Error(`${owner}.message must be a non-empty string`);
  }
  if (typeof value.retryable !== "boolean") throw new Error(`${owner}.retryable must be boolean`);
  return {
    code: value.code as FailureCode,
    message: value.message,
    retryable: value.retryable,
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}

function compileExpectation(
  raw: unknown,
  owner: string,
  workflow: WorkflowDefinition<unknown, unknown>,
  nodes: ReadonlyMap<string, WorkflowNode>,
): WorkflowScenarioExpectation {
  const value = requireRecord(raw, `${owner}.expect`);
  assertFields(
    value,
    ["status", "visits", "counts", "transitions", "failure", "requireAllMocksConsumed"],
    `${owner}.expect`,
  );
  if (value.status !== "success" && value.status !== "failure" && value.status !== "cancelled") {
    throw new Error(`${owner}.expect.status must be success, failure, or cancelled`);
  }
  const visits = optionalStringArray(value.visits, `${owner}.expect.visits`);
  for (const nodeId of visits ?? []) {
    if (!nodes.has(nodeId)) throw new Error(`${owner}.expect.visits references unknown state ${nodeId}`);
  }
  const countsValue = value.counts === undefined ? undefined : requireRecord(value.counts, `${owner}.expect.counts`);
  const counts: Record<string, number> = {};
  for (const [nodeId, count] of Object.entries(countsValue ?? {})) {
    if (!nodes.has(nodeId)) throw new Error(`${owner}.expect.counts references unknown state ${nodeId}`);
    if (!Number.isInteger(count) || Number(count) < 0) {
      throw new Error(`${owner}.expect.counts.${nodeId} must be a non-negative integer`);
    }
    counts[nodeId] = Number(count);
  }
  const transitions = optionalStringArray(value.transitions, `${owner}.expect.transitions`);
  for (const transition of transitions ?? []) {
    const [from, to, extra] = transition.split("->").map((part) => part.trim());
    if (!from || !to || extra || !workflow.graph.edges.some((edge) => edge.from === from && edge.to === to)) {
      throw new Error(`${owner}.expect.transitions references unknown transition ${transition}`);
    }
  }

  let failure: WorkflowScenarioExpectation["failure"];
  if (value.failure !== undefined) {
    const expected = requireRecord(value.failure, `${owner}.expect.failure`);
    assertFields(expected, ["code", "messageIncludes"], `${owner}.expect.failure`);
    if (expected.code !== undefined) {
      if (typeof expected.code !== "string" || !FAILURE_CODES.has(expected.code as FailureCode)) {
        throw new Error(`${owner}.expect.failure.code is not supported`);
      }
    }
    if (expected.messageIncludes !== undefined && typeof expected.messageIncludes !== "string") {
      throw new Error(`${owner}.expect.failure.messageIncludes must be a string`);
    }
    failure = {
      ...(expected.code ? { code: expected.code as FailureCode } : {}),
      ...(expected.messageIncludes ? { messageIncludes: expected.messageIncludes } : {}),
    };
  }

  if (
    value.requireAllMocksConsumed !== undefined &&
    typeof value.requireAllMocksConsumed !== "boolean"
  ) {
    throw new Error(`${owner}.expect.requireAllMocksConsumed must be boolean`);
  }
  return {
    status: value.status,
    ...(visits ? { visits } : {}),
    ...(Object.keys(counts).length > 0 ? { counts } : {}),
    ...(transitions ? { transitions } : {}),
    ...(failure ? { failure } : {}),
    requireAllMocksConsumed: value.requireAllMocksConsumed !== false,
  };
}

function requireRecord(value: unknown, owner: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${owner} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertFields(value: Record<string, unknown>, allowed: readonly string[], owner: string): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Error(`${owner} has unknown field ${key}`);
  }
}

function optionalStringArray(value: unknown, owner: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${owner} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requiredField(
  fields: Readonly<Record<string, string>> | undefined,
  key: string,
  owner: string,
): string {
  const value = fields?.[key];
  if (!value) throw new Error(`${owner} cannot resolve ${key}`);
  return value;
}

function validationError(
  owner: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): Error {
  return new Error(`${owner} is invalid: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
}
