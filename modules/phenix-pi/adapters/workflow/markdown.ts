import {
  type AnyDefinition,
  definitionRef,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../domain/definition/definition.ts";
import { type Difficulty, isDifficulty } from "../../domain/definition/model.ts";
import type { Schema } from "../../domain/definition/schema.ts";
import { definitionId } from "../../domain/shared.ts";
import {
  assertMarkdownFields,
  markdownInteger,
  markdownTitle,
  optionalMarkdownSubsection,
  parseMarkdownFields,
  parseMarkdownTable,
  requiredMarkdownFence,
  requiredMarkdownField,
  requiredMarkdownSection,
  requireMarkdownColumns,
} from "../definition/markdown.ts";

export interface WorkflowMarkdownBindings {
  resolveSchema(id: string): Schema<unknown>;
  resolveDefinition(id: string): AnyDefinition;
}

export interface AuthoredWorkflowState {
  readonly id: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly prompt?: string;
}

export interface AuthoredWorkflow {
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly states: readonly AuthoredWorkflowState[];
  readonly transitions: readonly WorkflowEdge[];
}

type StateKind = "invoke" | "local" | "decision" | "join" | "return" | "fail";

const WORKFLOW_FIELDS = [
  "id",
  "description",
  "input",
  "output",
  "entry",
  "difficulty-source",
  "timeout-ms",
  "max-node-runs",
  "max-parallelism",
] as const;

const STATE_FIELDS: Readonly<Record<StateKind, readonly string[]>> = {
  invoke: [
    "kind",
    "title",
    "run",
    "input",
    "wait",
    "difficulty",
    "input-schema",
    "output-schema",
  ],
  local: ["kind", "title", "operation", "input", "input-schema", "output-schema"],
  decision: ["kind", "title", "decide"],
  join: ["kind", "title", "policy", "quorum"],
  return: ["kind", "title", "output", "output-schema"],
  fail: ["kind", "title", "reason"],
};

export function parseWorkflowMarkdown(source: string): AuthoredWorkflow {
  const fields = parseMarkdownFields(requiredMarkdownFence(source, "phenix-workflow"));
  return {
    title: markdownTitle(source),
    fields,
    states: parseStates(requiredMarkdownSection(source, "States")),
    transitions: parseTransitions(requiredMarkdownSection(source, "Transitions")),
  };
}

export function compileWorkflowMarkdown(
  source: string,
  bindings: WorkflowMarkdownBindings,
): WorkflowDefinition<unknown, unknown> {
  const authored = parseWorkflowMarkdown(source);
  const fields = authored.fields;
  assertMarkdownFields(fields, WORKFLOW_FIELDS, "workflow");
  const input = bindings.resolveSchema(requiredMarkdownField(fields, "input", "workflow"));
  const output = bindings.resolveSchema(requiredMarkdownField(fields, "output", "workflow"));
  const nodes = authored.states.map((state) => compileState(state, bindings, output));
  const difficultySource = fields["difficulty-source"];
  if (difficultySource && !nodes.some((node) => node.id === difficultySource)) {
    throw new Error(`Workflow difficulty source ${difficultySource} is not a state`);
  }

  return {
    id: definitionId(requiredMarkdownField(fields, "id", "workflow")),
    kind: "workflow",
    title: authored.title,
    description: requiredMarkdownField(fields, "description", "workflow"),
    input,
    output,
    ...(difficultySource ? { difficultySource } : {}),
    limits: {
      timeoutMs: markdownInteger(fields, "timeout-ms", "workflow", 0),
      maxNodeRuns: markdownInteger(fields, "max-node-runs", "workflow", 1),
      maxParallelism: markdownInteger(fields, "max-parallelism", "workflow", 1),
    },
    graph: {
      entry: requiredMarkdownField(fields, "entry", "workflow"),
      nodes,
      edges: authored.transitions,
    },
  };
}

function compileState(
  state: AuthoredWorkflowState,
  bindings: WorkflowMarkdownBindings,
  workflowOutput: Schema<unknown>,
): WorkflowNode {
  if (state.prompt) {
    throw new Error(
      `Workflow state ${state.id} declares a Prompt section, but executable state prompts are not bound yet`,
    );
  }

  const owner = `state ${state.id}`;
  const fields = state.fields;
  const read = (key: string): string => requiredMarkdownField(fields, key, owner);
  const kind = parseStateKind(read("kind"), state.id);
  const common = { id: state.id, ...(fields.title ? { title: fields.title } : {}) };
  assertMarkdownFields(fields, STATE_FIELDS[kind], owner);

  switch (kind) {
    case "invoke": {
      const invoked = bindings.resolveDefinition(read("run"));
      assertSchema(bindings, read("input-schema"), invoked.input, `${owner} input`);
      assertSchema(bindings, read("output-schema"), invoked.output, `${owner} output`);
      return {
        ...common,
        kind,
        definition: definitionRef(definitionId(invoked.id)),
        input: read("input"),
        wait: parseWait(fields.wait ?? "await", state.id),
        ...(fields.difficulty ? { difficulty: parseDifficulty(fields.difficulty, owner) } : {}),
      };
    }
    case "local":
      bindings.resolveSchema(read("input-schema"));
      bindings.resolveSchema(read("output-schema"));
      return {
        ...common,
        kind,
        operation: read("operation"),
        input: read("input"),
      };
    case "decision":
      return { ...common, kind, decide: read("decide") };
    case "join":
      return {
        ...common,
        kind,
        policy: parseJoinPolicy(read("policy"), state.id),
        ...(fields.quorum ? { quorum: integerValue(fields.quorum, `${owner}.quorum`, 1) } : {}),
      };
    case "return":
      assertSchema(bindings, read("output-schema"), workflowOutput, `${owner} output`);
      return { ...common, kind, output: read("output") };
    case "fail":
      return { ...common, kind, reason: read("reason") };
  }
}

function assertSchema(
  bindings: WorkflowMarkdownBindings,
  declaredId: string,
  expected: Schema<unknown>,
  owner: string,
): void {
  const declared = bindings.resolveSchema(declaredId);
  if (declared.id !== expected.id) {
    throw new Error(`${owner} schema ${declared.id} does not match ${expected.id}`);
  }
}

function parseStates(section: string): AuthoredWorkflowState[] {
  const headings = [...section.matchAll(/^###\s+([A-Za-z0-9._:-]+)\s*$/gm)];
  if (headings.length === 0) throw new Error("Workflow States section has no states");

  return headings.map((heading, index) => {
    const id = heading[1];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? section.length;
    const body = section.slice(start, end);
    const prompt = optionalMarkdownSubsection(body, "Prompt")?.trim();
    return {
      id,
      fields: parseMarkdownFields(requiredMarkdownFence(body, "phenix-state")),
      ...(prompt ? { prompt } : {}),
    };
  });
}

function parseTransitions(section: string): WorkflowEdge[] {
  const table = parseMarkdownTable(section, "Transitions");
  requireMarkdownColumns(table, ["from", "to"], "Transitions");

  return table.rows.map((row, rowIndex) => {
    const from = row.from ?? "";
    const to = row.to ?? "";
    const when = row.when ?? "";
    const max = row["max-traversals"] || row.max || "";
    const difficulties = parseDifficulties(row.difficulties ?? "", rowIndex + 1);
    if (!from || !to) throw new Error(`Transitions row ${rowIndex + 1} requires From and To`);
    return {
      from,
      to,
      ...(when ? { when } : {}),
      ...(difficulties.length > 0 ? { difficulties } : {}),
      ...(max ? { maxTraversals: integerValue(max, `transition ${from}->${to}`, 1) } : {}),
    };
  });
}

function parseDifficulties(value: string, row: number): Difficulty[] {
  if (!value) return [];
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const result: Difficulty[] = [];
  for (const value of values) {
    if (!isDifficulty(value)) throw new Error(`Transitions row ${row} has unknown difficulty ${value}`);
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function parseDifficulty(value: string, owner: string): Difficulty {
  if (isDifficulty(value)) return value;
  throw new Error(`${owner}.difficulty must be D0, D1, D2, or D3`);
}

function integerValue(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function parseStateKind(value: string, stateId: string): StateKind {
  if (
    value === "invoke" ||
    value === "local" ||
    value === "decision" ||
    value === "join" ||
    value === "return" ||
    value === "fail"
  ) {
    return value;
  }
  throw new Error(`State ${stateId} has unsupported kind ${value}`);
}

function parseWait(value: string, stateId: string): "await" | "background" {
  if (value === "await" || value === "background") return value;
  throw new Error(`State ${stateId} has unsupported wait policy ${value}`);
}

function parseJoinPolicy(
  value: string,
  stateId: string,
): "all" | "all-success" | "first-success" | "quorum" {
  if (
    value === "all" ||
    value === "all-success" ||
    value === "first-success" ||
    value === "quorum"
  ) {
    return value;
  }
  throw new Error(`State ${stateId} has unsupported join policy ${value}`);
}
