import type { RunTreeNode } from "../../../application/interfaces.ts";
import type { RunFact } from "../../../domain/run/observability.ts";
import type { RunId } from "../../../domain/shared.ts";
import { color } from "../../observability-theme.ts";
import { defineWorkspaceView, type WorkspaceViewSnapshot } from "./workspace-view.ts";
import { truncateWorkspaceText } from "./workspace-view-format.ts";

export interface WorkspaceFileRow {
  readonly id: string;
  readonly path: string;
  readonly changeCount: number;
  readonly runIds: readonly RunId[];
  readonly latestSequence: number;
  readonly latestTimestamp: string;
  readonly latestSummary: string;
}

interface AccumulatedFileChange {
  readonly path: string;
  changeCount: number;
  readonly runIds: Set<RunId>;
  latest: RunFact;
}

export function projectWorkspaceFiles(
  snapshot: WorkspaceViewSnapshot,
  selectedRunId: RunId = snapshot.ui.tree.root.run.id,
): readonly WorkspaceFileRow[] {
  const scopedRunIds = collectRunSubtreeIds(snapshot.ui.tree.root, selectedRunId);
  if (scopedRunIds.size === 0) return [];

  const accumulated = new Map<string, AccumulatedFileChange>();
  const facts = [...snapshot.ui.facts].sort(compareFacts);
  for (const fact of facts) {
    if (fact.kind !== "file-changed" || !scopedRunIds.has(fact.runId)) continue;
    const filePath = fact.subject?.trim();
    if (!filePath) continue;

    const current = accumulated.get(filePath);
    if (current) {
      current.changeCount += 1;
      current.runIds.add(fact.runId);
      current.latest = fact;
      continue;
    }
    accumulated.set(filePath, {
      path: filePath,
      changeCount: 1,
      runIds: new Set([fact.runId]),
      latest: fact,
    });
  }

  return [...accumulated.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((change) => ({
      id: change.path,
      path: change.path,
      changeCount: change.changeCount,
      runIds: [...change.runIds],
      latestSequence: change.latest.sequence,
      latestTimestamp: change.latest.timestamp,
      latestSummary: change.latest.summary,
    }));
}

export const filesWorkspaceView = defineWorkspaceView<WorkspaceFileRow>({
  id: "files",
  title: "Files",
  layout: {
    weight: 3,
    minRows: 2,
    headerRows: 2,
    collapsePriority: 30,
  },
  project: (snapshot, context) =>
    projectWorkspaceFiles(snapshot, context?.selectedRunId).map((value) => ({
      id: value.id,
      value,
      render: ({ theme, width }) => {
        const count = value.changeCount > 1 ? color(theme, "muted", ` ×${value.changeCount}`) : "";
        const owners =
          value.runIds.length > 1 ? color(theme, "muted", ` · ${value.runIds.length} runs`) : "";
        return {
          text: `Δ ${truncateWorkspaceText(value.path, Math.max(8, width - 12))}${count}${owners}`,
        };
      },
    })),
});

function collectRunSubtreeIds(root: RunTreeNode, selectedRunId: RunId): ReadonlySet<RunId> {
  const selected = findRun(root, selectedRunId);
  if (!selected) return new Set();
  const result = new Set<RunId>();
  const visit = (node: RunTreeNode): void => {
    result.add(node.run.id);
    for (const child of node.children) visit(child);
  };
  visit(selected);
  return result;
}

function findRun(root: RunTreeNode, runId: RunId): RunTreeNode | undefined {
  if (root.run.id === runId) return root;
  for (const child of root.children) {
    const found = findRun(child, runId);
    if (found) return found;
  }
  return undefined;
}

function compareFacts(left: RunFact, right: RunFact): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}
