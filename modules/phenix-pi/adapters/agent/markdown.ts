import type { AgentDefinition } from "../../domain/definition/definition.ts";
import {
  DIFFICULTIES,
  type Difficulty,
  type DifficultyModelRoutes,
  isDifficulty,
  isModelCapability,
  isPhenixModelSet,
  type ModelSelector,
  type PiThinkingLevel,
  type ThinkingPolicy,
  virtualModel,
} from "../../domain/definition/model.ts";
import type { Schema } from "../../domain/definition/schema.ts";
import { definitionId } from "../../domain/shared.ts";
import {
  assertMarkdownFields,
  markdownBoolean,
  markdownEnum,
  markdownInteger,
  markdownList,
  markdownTitle,
  optionalMarkdownInteger,
  optionalMarkdownSection,
  parseMarkdownFields,
  parseMarkdownTable,
  requiredMarkdownFence,
  requiredMarkdownField,
  requiredMarkdownSection,
  requireMarkdownColumns,
} from "../definition/markdown.ts";

export interface AgentMarkdownBindings {
  resolveSchema(id: string): Schema<unknown>;
}

const AGENT_FIELDS = [
  "id",
  "description",
  "input",
  "output",
  "model",
  "thinking",
  "persistence",
] as const;
const TOOL_FIELDS = ["allow"] as const;
const CONTEXT_FIELDS = ["project-files", "parent-conversation", "artifacts", "max-bytes"] as const;
const CHILD_FIELDS = [
  "allow",
  "max-depth",
  "may-detach",
  "may-send",
  "may-cancel-children",
] as const;
const LIMIT_FIELDS = ["timeout-ms", "max-turns", "max-tool-calls", "max-repair-attempts"] as const;
const THINKING_POLICIES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "route",
] as const;
const THINKING_LEVELS = THINKING_POLICIES.filter(
  (value): value is PiThinkingLevel => value !== "route",
);
const MODEL_COLUMNS = ["difficulty", "model", "capability", "thinking"] as const;

export function compileAgentMarkdown(
  source: string,
  bindings: AgentMarkdownBindings,
): AgentDefinition<unknown, unknown> {
  const owner = "agent";
  const fields = parseMarkdownFields(requiredMarkdownFence(source, "phenix-agent"));
  const toolFields = sectionFields(source, "Tools", "phenix-tools");
  const contextFields = sectionFields(source, "Context", "phenix-context");
  const childFields = sectionFields(source, "Children", "phenix-children");
  const limitFields = sectionFields(source, "Limits", "phenix-limits");

  assertMarkdownFields(fields, AGENT_FIELDS, owner);
  assertMarkdownFields(toolFields, TOOL_FIELDS, "agent tools");
  assertMarkdownFields(contextFields, CONTEXT_FIELDS, "agent context");
  assertMarkdownFields(childFields, CHILD_FIELDS, "agent children");
  assertMarkdownFields(limitFields, LIMIT_FIELDS, "agent limits");

  const maxTurns = optionalMarkdownInteger(limitFields, "max-turns", "agent limits", 1);
  const maxToolCalls = optionalMarkdownInteger(limitFields, "max-tool-calls", "agent limits", 1);
  const prompt = requiredMarkdownSection(source, "Prompt").trim();
  if (!prompt) throw new Error("Agent Prompt section must not be empty");
  const modelRoutes = parseModelRoutes(source);

  return {
    id: definitionId(requiredMarkdownField(fields, "id", owner)),
    kind: "agent",
    title: markdownTitle(source),
    description: requiredMarkdownField(fields, "description", owner),
    input: bindings.resolveSchema(requiredMarkdownField(fields, "input", owner)),
    output: bindings.resolveSchema(requiredMarkdownField(fields, "output", owner)),
    model: parseModel(requiredMarkdownField(fields, "model", owner)),
    ...(modelRoutes ? { modelRoutes } : {}),
    thinking: markdownEnum(fields, "thinking", owner, THINKING_POLICIES) as ThinkingPolicy,
    prompt: { render: () => prompt },
    tools: { allow: markdownList(toolFields, "allow") },
    context: {
      projectFiles: markdownEnum(contextFields, "project-files", "agent context", [
        "inherit",
        "none",
        "selected",
      ] as const),
      parentConversation: markdownEnum(contextFields, "parent-conversation", "agent context", [
        "none",
        "summary",
        "selected-messages",
      ] as const),
      artifacts: markdownList(contextFields, "artifacts"),
      maxBytes: markdownInteger(contextFields, "max-bytes", "agent context", 0),
    },
    childCapabilities: {
      invokableDefinitions: markdownList(childFields, "allow").map(definitionId),
      maxDepth: markdownInteger(childFields, "max-depth", "agent children", 0),
      mayDetach: markdownBoolean(childFields, "may-detach", "agent children"),
      maySend: markdownBoolean(childFields, "may-send", "agent children"),
      mayCancelChildren: markdownBoolean(childFields, "may-cancel-children", "agent children"),
    },
    limits: {
      timeoutMs: markdownInteger(limitFields, "timeout-ms", "agent limits", 1),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      maxRepairAttempts: markdownInteger(limitFields, "max-repair-attempts", "agent limits", 0),
    },
    persistence: markdownEnum(fields, "persistence", owner, ["memory", "file"] as const),
  };
}

function sectionFields(source: string, heading: string, fence: string) {
  return parseMarkdownFields(
    requiredMarkdownFence(requiredMarkdownSection(source, heading), fence),
  );
}

function parseModelRoutes(source: string): DifficultyModelRoutes | undefined {
  const section = optionalMarkdownSection(source, "Models");
  if (section === undefined) return undefined;
  const table = parseMarkdownTable(section, "agent Models");
  requireMarkdownColumns(table, MODEL_COLUMNS, "agent Models");
  const knownColumns = new Set<string>(MODEL_COLUMNS);
  for (const column of table.columns) {
    if (!knownColumns.has(column)) throw new Error(`agent Models has unknown column ${column}`);
  }

  const routes = new Map<Difficulty, DifficultyModelRoutes[Difficulty]>();
  for (const [index, row] of table.rows.entries()) {
    const difficultyValue = requiredMarkdownField(
      row,
      "difficulty",
      `agent Models row ${index + 1}`,
    );
    if (!isDifficulty(difficultyValue)) {
      throw new Error(`agent Models row ${index + 1} has unknown difficulty ${difficultyValue}`);
    }
    if (routes.has(difficultyValue)) throw new Error(`agent Models repeats ${difficultyValue}`);

    const capability = requiredMarkdownField(row, "capability", `agent Models row ${index + 1}`);
    if (!isModelCapability(capability)) {
      throw new Error(`agent Models row ${index + 1} has unknown capability ${capability}`);
    }
    const thinking = requiredMarkdownField(row, "thinking", `agent Models row ${index + 1}`);
    if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) {
      throw new Error(`agent Models row ${index + 1} has unknown thinking level ${thinking}`);
    }
    routes.set(difficultyValue, {
      model: parseModel(requiredMarkdownField(row, "model", `agent Models row ${index + 1}`)),
      capability,
      thinking: thinking as PiThinkingLevel,
    });
  }

  for (const difficulty of DIFFICULTIES) {
    if (!routes.has(difficulty)) throw new Error(`agent Models is missing ${difficulty}`);
  }
  return Object.fromEntries(
    DIFFICULTIES.map((difficulty) => [difficulty, routes.get(difficulty)]),
  ) as DifficultyModelRoutes;
}

function parseModel(value: string): ModelSelector {
  if (value === "session") return { kind: "session" };
  if (value.startsWith("phenix:")) {
    const modelSet = value.slice("phenix:".length);
    if (!isPhenixModelSet(modelSet)) throw new Error(`Unknown Phenix model set ${modelSet}`);
    return virtualModel(modelSet);
  }
  const separator = value.indexOf("/");
  if (separator > 0 && separator < value.length - 1) {
    return {
      kind: "concrete",
      provider: value.slice(0, separator),
      model: value.slice(separator + 1),
    };
  }
  throw new Error(`Unsupported agent model ${value}`);
}
