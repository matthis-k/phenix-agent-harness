import { renderMermaidASCII } from "beautiful-mermaid";

import type { RunTree, RunTreeNode } from "../application/interfaces.ts";
import type {
  AnyDefinition,
  WorkflowDefinition,
  WorkflowNode,
} from "../domain/definition/definition.ts";

export interface TerminalMermaidOptions {
  readonly useAscii?: boolean;
  readonly compact?: boolean;
  readonly color?: boolean;
}

export interface RunSequenceOptions {
  readonly expanded?: boolean;
}

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);
const MAX_MERMAID_SOURCE_LENGTH = 64_000;

export function renderTerminalMermaid(
  source: string,
  options: TerminalMermaidOptions = {},
): string {
  const normalized = normalizeMermaidSource(source);
  if (normalized.length > MAX_MERMAID_SOURCE_LENGTH) {
    throw new Error(`Mermaid source exceeds ${MAX_MERMAID_SOURCE_LENGTH} characters`);
  }
  const header = normalized.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";
  if (
    !/^(?:flowchart|graph|statediagram|sequencediagram|classdiagram|erdiagram|xychart)/.test(header)
  ) {
    throw new Error(
      "Unsupported Mermaid diagram. Use flowchart, graph, stateDiagram, sequenceDiagram, classDiagram, erDiagram, or xychart.",
    );
  }
  return renderMermaidASCII(normalized, {
    useAscii: options.useAscii ?? false,
    paddingX: options.compact ? 3 : 5,
    paddingY: options.compact ? 2 : 4,
    boxBorderPadding: 1,
    colorMode: options.color ? "auto" : "none",
  }).trimEnd();
}

export function workflowDefinitionMermaid(
  definition: WorkflowDefinition<unknown, unknown>,
): string {
  const aliases = new Map(definition.graph.nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ["flowchart TD", "  entry((entry))"];
  for (const node of definition.graph.nodes) {
    const alias = aliases.get(node.id);
    if (!alias) continue;
    lines.push(`  ${workflowNodeDeclaration(alias, node)}`);
  }
  const entry = aliases.get(definition.graph.entry);
  if (entry) lines.push(`  entry --> ${entry}`);
  for (const edge of definition.graph.edges) {
    const from = aliases.get(edge.from);
    const to = aliases.get(edge.to);
    if (!from || !to) continue;
    const details = [edge.on && edge.on !== "success" ? edge.on : undefined, edge.when]
      .filter(Boolean)
      .join(" · ");
    lines.push(
      details ? `  ${from} -->|${escapeEdgeLabel(details)}| ${to}` : `  ${from} --> ${to}`,
    );
  }
  return lines.join("\n");
}

export function renderCatalogDefinition(definition: AnyDefinition): string {
  const lines = [
    `${definition.id} — ${definition.title}`,
    definition.description,
    `kind: ${definition.kind} · input: ${definition.input.id} · output: ${definition.output.id}`,
  ];
  if (definition.kind === "workflow") {
    lines.push("", renderTerminalMermaid(workflowDefinitionMermaid(definition), { compact: true }));
  } else {
    lines.push(
      `model: ${formatModelSelector(definition.model)} · thinking: ${formatThinking(definition.thinking)}`,
      `tools: ${definition.tools.allow.join(", ") || "none"}`,
    );
  }
  return lines.join("\n");
}

export function runTreeSequenceMermaid(tree: RunTree, options: RunSequenceOptions = {}): string {
  const participantIds = new Map<string, string>();
  const participants: Array<{ readonly id: string; readonly label: string }> = [];
  const rootId = registerParticipant(tree.root, participantIds, participants);

  const collect = (node: RunTreeNode): void => {
    if (node.run.kind === "workflow" && isCollapsedWorkflow(node, options.expanded)) return;
    if (node.run.kind === "agent") registerParticipant(node, participantIds, participants);
    for (const child of node.children) collect(child);
  };
  for (const child of tree.root.children) collect(child);

  const lines = ["sequenceDiagram"];
  for (const participant of participants) {
    lines.push(`  participant ${participant.id} as ${escapeSequenceText(participant.label)}`);
  }

  const visit = (node: RunTreeNode, caller: string): void => {
    if (node.run.kind === "workflow") {
      const label = `${definitionLabel(String(node.run.definitionId))} · ${node.run.state}`;
      const collapsed = isCollapsedWorkflow(node, options.expanded);
      if (collapsed) {
        lines.push(
          `  ${caller}->>${caller}: ${escapeSequenceText(
            `workflow ${label} · ${descendantCount(node)} descendants`,
          )}`,
        );
        return;
      }

      lines.push(`  rect workflow ${escapeSequenceText(label)}`);
      lines.push(`    ${caller}->>${caller}: ${escapeSequenceText(`enter ${label}`)}`);
      for (const child of node.children) visit(child, caller);
      lines.push(`    ${caller}-->>${caller}: ${escapeSequenceText(`leave · ${node.run.state}`)}`);
      lines.push("  end");
      return;
    }

    if (node.run.kind !== "agent") {
      for (const child of node.children) visit(child, caller);
      return;
    }

    const target = participantIds.get(String(node.run.id));
    if (!target) return;
    lines.push(`  ${caller}->>${target}: ${escapeSequenceText(`start · ${node.run.state}`)}`);
    const model = node.run.resolvedModel;
    if (model) {
      lines.push(
        `  Note right of ${target}: ${escapeSequenceText(
          `${model.concrete.provider}/${model.concrete.model} · ${model.thinking}`,
        )}`,
      );
    }
    if (node.activity) {
      const reported = node.activity.source === "reported" ? "! " : "";
      const targetSuffix = node.activity.target ? ` → ${node.activity.target}` : "";
      lines.push(
        `  Note right of ${target}: ${escapeSequenceText(
          `${reported}${node.activity.phase} ${node.activity.summary}${targetSuffix}`,
        )}`,
      );
    }
    for (const child of node.children) visit(child, target);
    if (TERMINAL_RUN_STATES.has(node.run.state)) {
      lines.push(`  ${target}-->>${caller}: ${escapeSequenceText(node.run.state)}`);
    }
  };

  for (const child of tree.root.children) visit(child, rootId);
  return lines.join("\n");
}

export function renderRunTreeSequence(tree: RunTree, options: RunSequenceOptions = {}): string {
  return renderTerminalMermaid(runTreeSequenceMermaid(tree, options), { compact: true });
}

function workflowNodeDeclaration(alias: string, node: WorkflowNode): string {
  const title = escapeNodeLabel(node.title ?? node.id);
  switch (node.kind) {
    case "invoke":
      return `${alias}["invoke · ${title}<br/>${escapeNodeLabel(String(node.definition.id))}"]`;
    case "decision":
      return `${alias}{"decision · ${title}"}`;
    case "join":
      return `${alias}["join · ${title}<br/>${escapeNodeLabel(node.policy)}"]`;
    case "local":
      return `${alias}["local · ${title}<br/>${escapeNodeLabel(node.operation)}"]`;
    case "return":
      return `${alias}(["return · ${title}"])`;
    case "fail":
      return `${alias}(["fail · ${title}"])`;
  }
}

function registerParticipant(
  node: RunTreeNode,
  ids: Map<string, string>,
  participants: Array<{ readonly id: string; readonly label: string }>,
): string {
  const key = String(node.run.id);
  const existing = ids.get(key);
  if (existing) return existing;
  const id = `p${participants.length}`;
  ids.set(key, id);
  participants.push({ id, label: participantLabel(node) });
  return id;
}

function participantLabel(node: RunTreeNode): string {
  if (node.run.kind === "root") return "root";
  const name = definitionLabel(String(node.run.definitionId));
  const suffix = shortRunId(String(node.run.id));
  const model = node.run.resolvedModel;
  return model
    ? `${name} · ${suffix}<br/>${model.concrete.model} · ${model.thinking}`
    : `${name} · ${suffix}`;
}

function isCollapsedWorkflow(node: RunTreeNode, expanded = false): boolean {
  return !expanded && node.run.kind === "workflow" && TERMINAL_RUN_STATES.has(node.run.state);
}

function descendantCount(node: RunTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + descendantCount(child), 0);
}

function formatModelSelector(selector: unknown): string {
  if (typeof selector !== "object" || selector === null) return String(selector);
  const record = selector as Record<string, unknown>;
  if (record.kind === "concrete") return `${record.provider}/${record.model}`;
  if (typeof record.kind === "string") return record.kind;
  return "configured";
}

function formatThinking(thinking: unknown): string {
  if (typeof thinking === "string") return thinking;
  if (typeof thinking !== "object" || thinking === null) return String(thinking);
  const record = thinking as Record<string, unknown>;
  return typeof record.kind === "string" ? record.kind : "configured";
}

function normalizeMermaidSource(source: string): string {
  const trimmed = source.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function escapeNodeLabel(value: string): string {
  return normalizeText(value).replace(/["\\]/g, "'").replace(/[|]/g, "¦");
}

function escapeEdgeLabel(value: string): string {
  return normalizeText(value).replace(/[|]/g, "¦");
}

function escapeSequenceText(value: string): string {
  return normalizeText(value).replace(/:/g, "∶").replace(/;/g, ",");
}

function normalizeText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function definitionLabel(value: string): string {
  return value.replace(/^(?:agent|workflow)\./, "");
}

function shortRunId(value: string): string {
  const normalized = value.replace(/^run-/, "");
  return normalized.length <= 8 ? normalized : normalized.slice(-8);
}
