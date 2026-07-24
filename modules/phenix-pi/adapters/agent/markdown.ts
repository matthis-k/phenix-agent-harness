import type { AgentDefinition } from "../../domain/definition/definition.ts";
import {
  isPhenixModelSet,
  type ModelSelector,
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
  parseMarkdownFields,
  requiredMarkdownFence,
  requiredMarkdownField,
  requiredMarkdownSection,
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
const THINKING_POLICIES = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "route"] as const;

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

  return {
    id: definitionId(requiredMarkdownField(fields, "id", owner)),
    kind: "agent",
    title: markdownTitle(source),
    description: requiredMarkdownField(fields, "description", owner),
    input: bindings.resolveSchema(requiredMarkdownField(fields, "input", owner)),
    output: bindings.resolveSchema(requiredMarkdownField(fields, "output", owner)),
    model: parseModel(requiredMarkdownField(fields, "model", owner)),
    thinking: markdownEnum(fields, "thinking", owner, THINKING_POLICIES) as ThinkingPolicy,
    prompt: { render: () => prompt },
    tools: { allow: markdownList(toolFields, "allow") },
    context: {
      projectFiles: markdownEnum(
        contextFields,
        "project-files",
        "agent context",
        ["inherit", "none", "selected"] as const,
      ),
      parentConversation: markdownEnum(
        contextFields,
        "parent-conversation",
        "agent context",
        ["none", "summary", "selected-messages"] as const,
      ),
      artifacts: markdownList(contextFields, "artifacts"),
      maxBytes: markdownInteger(contextFields, "max-bytes", "agent context", 0),
    },
    childCapabilities: {
      invokableDefinitions: markdownList(childFields, "allow").map(definitionId),
      maxDepth: markdownInteger(childFields, "max-depth", "agent children", 0),
      mayDetach: markdownBoolean(childFields, "may-detach", "agent children"),
      maySend: markdownBoolean(childFields, "may-send", "agent children"),
      mayCancelChildren: markdownBoolean(
        childFields,
        "may-cancel-children",
        "agent children",
      ),
    },
    limits: {
      timeoutMs: markdownInteger(limitFields, "timeout-ms", "agent limits", 1),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      maxRepairAttempts: markdownInteger(
        limitFields,
        "max-repair-attempts",
        "agent limits",
        0,
      ),
    },
    persistence: markdownEnum(
      fields,
      "persistence",
      owner,
      ["memory", "file"] as const,
    ),
  };
}

function sectionFields(source: string, heading: string, fence: string) {
  return parseMarkdownFields(requiredMarkdownFence(requiredMarkdownSection(source, heading), fence));
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
