import {
  definitionRef,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../definition/definition.ts";
import type { Schema } from "../definition/schema.ts";
import { definitionId } from "../shared.ts";

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
  assertKnownFields(fields, [
    "id",
    "description",
    "input",
    "output",
    "entry",
    "timeout-ms",
    "max-node-runs",
    "max-parallelism",
  ], "workflow");

  return {
    id: definitionId(requiredField(fields, "id", "workflow")),
    kind: "workflow",
    title: authored.title,
    description: requiredField(fields, "description", "workflow"),
    input: bindings.resolveSchema(requiredField(fields, "input", "workflow")),
    output: bindings.resolveSchema(requiredField(fields, "output", "workflow")),
    limits: {
      timeoutMs: integerField(fields, "timeout-ms", "workflow"),
      maxNodeRuns: integerField(fields, "max-node-runs", "workflow"),
      maxParallelism: integerField(fields, "max-parallelism", "workflow"),
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

  const fields = state.fields;
  const kind = requiredField(fields, "kind", `state ${state.id}`);
  const title = fields.title;
  const common = { id: state.id, ...(title ? { title } : {}) };

  switch (kind) {
    case "invoke":
      assertKnownFields(fields, ["kind", "title", "run", "input", "wait"], `state ${state.id}`);
      return {
        ...common,
        kind,
        definition: definitionRef(definitionId(requiredField(fields, "run", `state ${state.id}`))),
        input: requiredField(fields, "input", `state ${state.id}`),
        wait: parseWait(fields.wait ?? "await", state.id),
      };
    case "local":
      assertKnownFields(fields, ["kind", "title", "operation", "input"], `state ${state.id}`);
      return {
        ...common,
        kind,
        operation: requiredField(fields, "operation", `state ${state.id}`),
        input: requiredField(fields, "input", `state ${state.id}`),
      };
    case "decision":
      assertKnownFields(fields, ["kind", "title", "decide"], `state ${state.id}`);
      return {
        ...common,
        kind,
        decide: requiredField(fields, "decide", `state ${state.id}`),
      };
    case "join": {
      assertKnownFields(fields, ["kind", "title", "policy", "quorum"], `state ${state.id}`);
      const policy = parseJoinPolicy(requiredField(fields, "policy", `state ${state.id}`), state.id);
      return {
        ...common,
        kind,
        policy,
        ...(fields.quorum ? { quorum: integerValue(fields.quorum, `state ${state.id}.quorum`) } : {}),
      };
    }
    case "return":
      assertKnownFields(fields, ["kind", "title", "output"], `state ${state.id}`);
      return {
        ...common,
        kind,
        output: requiredField(fields, "output", `state ${state.id}`),
      };
    case "fail":
      assertKnownFields(fields, ["kind", "title", "reason"], `state ${state.id}`);
      return {
        ...common,
        kind,
        reason: requiredField(fields, "reason", `state ${state.id}`),
      };
    default:
      throw new Error(`Unsupported workflow state kind ${kind} at ${state.id}`);
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
  const indexes = new Map(headers.map((header, index) => [header, index]));
  for (const required of ["from", "to"]) {
    if (!indexes.has(required)) throw new Error(`Transitions table is missing ${required}`);
  }

  return rows.slice(2).map((row, rowIndex) => {
    const cells = tableCells(row);
    const from = tableValue(cells, indexes, "from");
    const to = tableValue(cells, indexes, "to");
    const when = tableValue(cells, indexes, "when", false);
    const max =
      tableValue(cells, indexes, "max-traversals", false) ||
      tableValue(cells, indexes, "max", false);
    if (!from || !to) throw new Error(`Transitions row ${rowIndex + 1} requires From and To`);
    return {
      from,
      to,
      ...(when ? { when } : {}),
      ...(max ? { maxTraversals: integerValue(max, `transition ${from}->${to}`) } : {}),
    };
  });
}

function parseFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [index, rawLine] of block.split("\n").entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid field on line ${index + 1}: ${rawLine}`);
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (key in fields) throw new Error(`Duplicate field ${key}`);
    fields[key] = value;
  }
  return fields;
}

function requiredSection(source: string, heading: string): string {
  const marker = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) throw new Error(`Missing ## ${heading} section`);
  const start = marker.index + marker[0].length;
  const remainder = source.slice(start);
  const next = /^##\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

function optionalSubsection(source: string, heading: string): string | undefined {
  const marker = new RegExp(`^####\\s+${escapeRegExp(heading)}\\s*$`, "m").exec(source);
  if (!marker || marker.index === undefined) return undefined;
  const start = marker.index + marker[0].length;
  const remainder = source.slice(start);
  const next = /^####\s+/m.exec(remainder);
  return remainder.slice(0, next?.index ?? remainder.length);
}

function requiredFence(source: string, language: string): string {
  const match = new RegExp(`\\x60\\x60\\x60${escapeRegExp(language)}\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`, "m").exec(source);
  if (!match) throw new Error(`Missing fenced ${language} block`);
  return match[1];
}

function requiredMatch(source: string, pattern: RegExp, name: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1];
}

function requiredField(fields: Readonly<Record<string, string>>, key: string, owner: string): string {
  const value = fields[key];
  if (!value) throw new Error(`${owner} requires ${key}`);
  return value;
}

function integerField(fields: Readonly<Record<string, string>>, key: string, owner: string): number {
  return integerValue(requiredField(fields, key, owner), `${owner}.${key}`);
}

function integerValue(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
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

function parseWait(value: string, stateId: string): "await" | "background" {
  if (value === "await" || value === "background") return value;
  throw new Error(`State ${stateId} has unsupported wait policy ${value}`);
}

function parseJoinPolicy(
  value: string,
  stateId: string,
): "all" | "all-success" | "first-success" | "quorum" {
  if (value === "all" || value === "all-success" || value === "first-success" || value === "quorum") {
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
