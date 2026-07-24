import {
  definitionRef,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../domain/definition/definition.ts";
import type { Schema } from "../../domain/definition/schema.ts";
import { definitionId } from "../../domain/shared.ts";

export interface WorkflowMarkdownBindings {
  resolveSchema(id: string): Schema<unknown>;
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
  "timeout-ms",
  "max-node-runs",
  "max-parallelism",
] as const;

const STATE_FIELDS: Readonly<Record<StateKind, readonly string[]>> = {
  invoke: ["kind", "title", "run", "input", "wait"],
  local: ["kind", "title", "operation", "input"],
  decision: ["kind", "title", "decide"],
  join: ["kind", "title", "policy", "quorum"],
  return: ["kind", "title", "output"],
  fail: ["kind", "title", "reason"],
};

const FENCE = "\\x60\\x60\\x60";

export function parseWorkflowMarkdown(source: string): AuthoredWorkflow {
  const title = requiredMatch(source, /^#\s+(.+)$/m, "workflow title").trim();
  const fields = parseFields(requiredFence(source, "phenix-workflow"));
  const states = parseStates(requiredSection(source, "States"));
  const transitions = parseTransitions(requiredSection(source, "Transitions"));
  return { title, fields, states, transitions };
}

export function compileWorkflowMarkdown(
  source: string,
  bindings: WorkflowMarkdownBindings,
): WorkflowDefinition<unknown, unknown> {
  const authored = parseWorkflowMarkdown(source);
  const fields = authored.fields;
  assertKnownFields(fields, WORKFLOW_FIELDS, "workflow");

  return {
    id: definitionId(requiredField(fields, "id", "workflow")),
    kind: "workflow",
    title: authored.title,
    description: requiredField(fields, "description", "workflow"),
    input: bindings.resolveSchema(requiredField(fields, "input", "workflow")),
    output: bindings.resolveSchema(requiredField(fields, "output", "workflow")),
    limits: {
      timeoutMs: integerField(fields, "timeout-ms", "workflow", 0),
      maxNodeRuns: integerField(fields, "max-node-runs", "workflow", 1),
      maxParallelism: integerField(fields, "max-parallelism", "workflow", 1),
    },
    graph: {
      entry: requiredField(fields, "entry", "workflow"),
      nodes: authored.states.map(compileState),
      edges: authored.transitions,
    },
  };
}

function compileState(state: AuthoredWorkflowState): WorkflowNode {
  if (state.prompt) {
    throw new Error(
      `Workflow state ${state.id} declares a Prompt section, but executable state prompts are not bound yet`,
    );
  }

  const owner = `state ${state.id}`;
  const fields = state.fields;
  const read = (key: string): string => requiredField(fields, key, owner);
  const kind = parseStateKind(read("kind"), state.id);
  const common = { id: state.id, ...(fields.title ? { title: fields.title } : {}) };
  assertKnownFields(fields, STATE_FIELDS[kind], owner);

  switch (kind) {
    case "invoke":
      return {
        ...common,
        kind,
        definition: definitionRef(definitionId(read("run"))),
        input: read("input"),
        wait: parseWait(fields.wait ?? "await", state.id),
      };
    case "local":
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
        ...(fields.quorum
          ? { quorum: integerValue(fields.quorum, `${owner}.quorum`, 1) }
          : {}),
      };
    case "return":
      return { ...common, kind, output: read("output") };
    case "fail":
      return { ...common, kind, reason: read("reason") };
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
    const prompt = optionalSubsection(body, "Prompt")?.trim();
    return {
      id,
      fields: parseFields(requiredFence(body, "phenix-state")),
      ...(prompt ? { prompt } : {}),
    };
  });
}

function parseTransitions(section: string): WorkflowEdge[] {
  const rows = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"));
  if (rows.length < 2) throw new Error("Transitions must be a Markdown table");

  const headers = tableCells(rows[0]).map(normalizeHeader);
  const indexes = new Map(headers.map((header, index) => [header, index] as const));
  requireColumns(indexes, ["from", "to"]);

  return rows.slice(2).map((row, rowIndex) => {
    const cells = tableCells(row);
    const from = tableValue(cells, indexes, "from");
    const to = tableValue(cells, indexes, "to");
    const when = tableValue(cells, indexes, "when", false);
    const max =
      tableValue(cells, indexes, "max-traversals", false) ||
      tableValue(cells, indexes, "max", false);
    if (!from || !to) {
      throw new Error(`Transitions row ${rowIndex + 1} requires From and To`);
    }
    return {
      from,
      to,
      ...(when ? { when } : {}),
      ...(max
        ? { maxTraversals: integerValue(max, `transition ${from}->${to}`, 1) }
        : {}),
    };
  });
}

function parseFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [index, rawLine] of block.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(`Invalid field on line ${index + 1}: ${rawLine}`);
    }
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key in fields) throw new Error(`Duplicate field ${key}`);
    fields[key] = value;
  }
  return fields;
}

function requiredSection(source: string, heading: string): string {
  const marker = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) {
    throw new Error(`Missing ## ${heading} section`);
  }
  const remainder = source.slice(marker.index + marker[0].length);
  const next = /^##\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

function optionalSubsection(source: string, heading: string): string | undefined {
  const marker = new RegExp(`^####\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const remainder = source.slice(marker.index + marker[0].length);
  const next = /^####\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

function requiredFence(source: string, language: string): string {
  const pattern = `${FENCE}${escapeRegExp(language)}\\s*\\n([\\s\\S]*?)\\n${FENCE}`;
  const match = new RegExp(pattern, "m").exec(source);
  if (!match) throw new Error(`Missing fenced ${language} block`);
  return match[1];
}

function requiredMatch(source: string, pattern: RegExp, name: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1];
}

function requiredField(
  fields: Readonly<Record<string, string>>,
  key: string,
  owner: string,
): string {
  const value = fields[key];
  if (!value) throw new Error(`${owner} requires ${key}`);
  return value;
}

function integerField(
  fields: Readonly<Record<string, string>>,
  key: string,
  owner: string,
  minimum: number,
): number {
  return integerValue(requiredField(fields, key, owner), `${owner}.${key}`, minimum);
}

function integerValue(value: string, name: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function assertKnownFields(
  fields: Readonly<Record<string, string>>,
  allowed: readonly string[],
  owner: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(fields)) {
    if (!known.has(key)) throw new Error(`${owner} has unknown field ${key}`);
  }
}

function requireColumns(
  indexes: ReadonlyMap<string, number>,
  required: readonly string[],
): void {
  for (const column of required) {
    if (!indexes.has(column)) throw new Error(`Transitions table is missing ${column}`);
  }
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

function tableCells(row: string): string[] {
  return row
    .slice(1, -1)
    .split("|")
    .map((cell) => unquote(cell.trim().replace(/^`|`$/g, "")));
}

function tableValue(
  cells: readonly string[],
  indexes: ReadonlyMap<string, number>,
  key: string,
  required = true,
): string {
  const index = indexes.get(key);
  if (index === undefined) {
    if (required) throw new Error(`Transitions table is missing ${key}`);
    return "";
  }
  return cells[index] ?? "";
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-");
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
