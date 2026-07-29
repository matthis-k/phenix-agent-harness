import type { RunTreeNode } from "../../application/interfaces.ts";
import type { TaskNode, TaskTree } from "../../domain/task/projection.ts";
import type { WorkspaceItemIndex } from "../../domain/workspace/events.ts";
import type { NativeRunTranscript } from "../native-run-transcript.ts";
import type { PhenixUiSnapshot } from "../phenix-ui.ts";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);

export interface PhenixWorkspaceSnapshot {
  readonly ui: PhenixUiSnapshot;
  readonly tasks: TaskTree;
  readonly rootTranscript: NativeRunTranscript;
}

export interface WorkspaceRunRow {
  readonly node: RunTreeNode;
  readonly depth: number;
}

export interface WorkspaceTaskRow {
  readonly node: TaskNode;
  readonly depth: number;
}

export function projectWorkspaceRuns(root: RunTreeNode): readonly WorkspaceRunRow[] {
  const result: WorkspaceRunRow[] = [];
  const visit = (node: RunTreeNode, depth: number): void => {
    result.push({ node, depth });
    const autoCollapsed =
      node.run.kind !== "root" && TERMINAL_STATES.has(node.run.state) && node.children.length > 0;
    if (autoCollapsed) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return result;
}

export function projectWorkspaceTasks(root: TaskNode): readonly WorkspaceTaskRow[] {
  const result: WorkspaceTaskRow[] = [];
  const visit = (node: TaskNode, depth: number): void => {
    if (depth > 0) result.push({ node, depth: depth - 1 });
    if (node.effectiveState === "done" && node.children.length > 0) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return result;
}

export function workspaceItemIndex(snapshot: PhenixWorkspaceSnapshot): WorkspaceItemIndex {
  return {
    transcript: [],
    editor: [],
    runs: projectWorkspaceRuns(snapshot.ui.tree.root).map((row) => String(row.node.run.id)),
    tasks: projectWorkspaceTasks(snapshot.tasks.root).map((row) => row.node.id),
    files: [],
    facts: [...snapshot.ui.facts]
      .reverse()
      .slice(0, 50)
      .map((fact) => fact.id),
  };
}

export function findWorkspaceRun(root: RunTreeNode, id: string): RunTreeNode | undefined {
  if (String(root.run.id) === id) return root;
  for (const child of root.children) {
    const found = findWorkspaceRun(child, id);
    if (found) return found;
  }
  return undefined;
}
