import type * as acp from "@agentclientprotocol/sdk";

import type { HeadlessImage } from "./protocol.ts";

export interface TranscriptBlock {
  readonly id: string;
  readonly runId: string;
  readonly role: string;
  readonly text: string;
}

export function promptContent(blocks: readonly acp.ContentBlock[]): {
  readonly text: string;
  readonly images: readonly HeadlessImage[];
} {
  const text: string[] = [];
  const images: HeadlessImage[] = [];
  for (const block of blocks) {
    const item = record(block);
    if (block.type === "text") {
      const value = stringValue(item.text);
      if (value) text.push(value);
    }
    if (block.type === "image") {
      images.push({
        data: requiredString(item.data, "image data"),
        mediaType: requiredString(item.mimeType, "image media type"),
      });
    }
    if (block.type === "resource") {
      const value = stringValue(record(item.resource).text);
      if (value) text.push(value);
    }
  }
  return { text: text.join("\n"), images };
}

export function extractSelectedBranchTranscript(raw: unknown): readonly TranscriptBlock[] {
  const root = record(raw);
  const tree = record(root.tree);
  const entries = arrayValue(tree.entries ?? root.entries);
  const leaf = stringValue(root.leafEntryId) ?? stringValue(tree.leafEntryId);
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of entries) {
    const entry = record(value);
    const id = stringValue(entry.id);
    if (id) byId.set(id, entry);
  }
  const selected = leaf ? selectedAncestors(byId, leaf) : entries.map(record);
  return selected.flatMap((entry, index) => transcriptFromEntry(entry, index));
}

export function projectSessionTreeSnapshot(
  treeId: string,
  snapshot: Readonly<Record<string, unknown>>,
  definition: unknown,
): Record<string, unknown> {
  const workspace = record(snapshot.workspace);
  const runTree = record(workspace.tree);
  const rootNode = record(runTree.root);
  const nodes: Record<string, unknown>[] = [];
  visitRunNode(rootNode, undefined, nodes);
  const objectives = flattenObjectives(record(workspace.objectives).roots);
  const root =
    stringValue(record(rootNode.run).id) ?? requiredString(snapshot.rootRunId, "root run id");
  return {
    id: treeId,
    definition_id: definitionId(definition),
    root,
    nodes,
    objectives,
    active_workflow: null,
  };
}

function visitRunNode(
  node: Readonly<Record<string, unknown>>,
  parent: string | undefined,
  output: Record<string, unknown>[],
): void {
  const run = record(node.run);
  const id = stringValue(run.id);
  if (!id) return;
  const model = record(run.resolvedModel ?? run.observedModel ?? run.model);
  const provider = stringValue(model.provider);
  const modelId = stringValue(model.model ?? model.id);
  output.push({
    id,
    parent: parent ?? null,
    role: stringValue(run.definitionId) ?? stringValue(run.kind) ?? "agent.stock",
    state: sessionNodeState(stringValue(run.state)),
    backend: "pi",
    downstream_session: stringValue(run.sessionId) ?? stringValue(run.persistedSession) ?? null,
    model: provider && modelId ? { provider, model: modelId } : null,
  });
  for (const child of arrayValue(node.children)) visitRunNode(record(child), id, output);
}

function flattenObjectives(raw: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (value: unknown, parent: string | undefined): void => {
    const objective = record(value);
    const id = stringValue(objective.id);
    if (!id) return;
    result.push({
      id,
      parent: parent ?? null,
      title: stringValue(objective.title) ?? id,
      state: objectiveState(stringValue(objective.effectiveState ?? objective.state)),
    });
    for (const child of arrayValue(objective.children)) visit(child, id);
  };
  for (const root of arrayValue(raw)) visit(root, undefined);
  return result;
}

function selectedAncestors(
  byId: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  leaf: string,
): Readonly<Record<string, unknown>>[] {
  const path: Readonly<Record<string, unknown>>[] = [];
  const visited = new Set<string>();
  let current = byId.get(leaf);
  while (current) {
    const id = stringValue(current.id);
    if (!id || visited.has(id)) break;
    visited.add(id);
    path.push(current);
    const parent = stringValue(current.parentId ?? current.parentEntryId ?? current.parent);
    current = parent ? byId.get(parent) : undefined;
  }
  return path.reverse();
}

function transcriptFromEntry(
  entry: Readonly<Record<string, unknown>>,
  index: number,
): TranscriptBlock[] {
  const message = record(entry.message ?? entry.value ?? entry);
  const role = stringValue(message.role) ?? stringValue(entry.role);
  if (!role || !["user", "assistant", "thinking"].includes(role)) return [];
  const text = contentText(message.content ?? entry.content ?? message.text ?? entry.text);
  if (!text) return [];
  return [
    {
      id: stringValue(entry.id) ?? `replay-${index}`,
      runId: stringValue(entry.runId) ?? "",
      role,
      text,
    },
  ];
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const item = record(block);
      return stringValue(item.text) ?? stringValue(item.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function transcriptBlock(value: unknown): TranscriptBlock | undefined {
  const block = record(value);
  const id = stringValue(block.id);
  const runId = stringValue(block.runId);
  const role = stringValue(block.role);
  const text = stringValue(block.text);
  return id && runId && role && text !== undefined ? { id, runId, role, text } : undefined;
}

export function configValue(value: acp.SessionConfigOptionValue): string {
  if (typeof value === "string") return value;
  const item = record(value);
  return stringValue(item.value) ?? stringValue(item.valueId) ?? String(value);
}

export function thinkingLevel(
  value: string,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const normalized = value.toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "extra_high":
    case "xhigh":
      return "xhigh";
    default:
      throw new Error(`Unsupported thinking level: ${value}`);
  }
}

export function toolKind(name: string | undefined): acp.ToolKind {
  const normalized = name?.toLowerCase() ?? "";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "edit";
  if (normalized.includes("search") || normalized.includes("grep")) return "search";
  if (normalized.includes("fetch") || normalized.includes("web")) return "fetch";
  if (normalized.includes("delete")) return "delete";
  return "execute";
}

function sessionNodeState(value: string | undefined): string {
  switch (value) {
    case "created":
      return "Created";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting_for_input":
    case "waiting":
      return "WaitingForInput";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "orphaned":
      return "Orphaned";
    default:
      return "Created";
  }
}

function objectiveState(value: string | undefined): string {
  switch (value) {
    case "wip":
      return "WorkInProgress";
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    default:
      return "NotStarted";
  }
}

export function definitionId(definition: unknown): string {
  const item = record(definition);
  return stringValue(item.id) ?? stringValue(item.definition_id) ?? "phenix.current";
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}
