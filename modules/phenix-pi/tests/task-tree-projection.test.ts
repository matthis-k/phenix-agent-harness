import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderTaskTree } from "@matthis-k/phenix-suite/tasks/suite-integration.ts";
import type { TaskNode, TaskSummary } from "@matthis-k/phenix-tasks/index.ts";

function node(input: Partial<TaskNode> & Pick<TaskNode, "id" | "title">): TaskNode {
  return {
    workflowId: "workflow-test",
    parentId: null,
    position: 0,
    explicitState: "not_started",
    createdBySessionId: "root-session",
    revision: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    effectiveState: "not_started",
    children: [],
    ...input,
  };
}

describe("Phenix task tree projection", () => {
  it("renders hierarchy, state, and owning session in a compact widget", () => {
    const root = node({
      id: "root",
      title: "Full QA",
      explicitState: "wip",
      effectiveState: "wip",
      assignedSessionId: "019f7cd5-root",
      children: [
        node({
          id: "scout",
          parentId: "root",
          title: "Scout repository",
          explicitState: "done",
          effectiveState: "done",
          assignedSessionId: "019f7cd5-scout",
          completedBySessionId: "019f7cd5-scout",
        }),
        node({
          id: "review",
          parentId: "root",
          position: 1,
          title: "Review findings",
        }),
      ],
    });
    const summary: TaskSummary = { total: 3, notStarted: 1, wip: 1, done: 1 };

    assert.deepEqual(renderTaskTree(root, summary), [
      "Tasks · 1/3 done · 1 wip",
      "◐ Full QA · @019f7cd5",
      "├─ ✓ Scout repository · @019f7cd5",
      "└─ ○ Review findings",
    ]);
  });
});
