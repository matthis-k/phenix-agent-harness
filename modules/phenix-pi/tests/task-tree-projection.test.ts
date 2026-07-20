import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderTaskTree,
  taskCommandCompletions,
} from "@matthis-k/phenix-suite/tasks/suite-integration.ts";
import type { TaskReference, TaskSummary, TaskTreeNode } from "@matthis-k/phenix-tasks/index.ts";

function node(input: Partial<TaskTreeNode> & Pick<TaskTreeNode, "uid" | "name">): TaskTreeNode {
  return {
    status: "not_started",
    ownStatus: "not_started",
    log: [],
    children: [],
    ...input,
  };
}

describe("Phenix task tree projection", () => {
  it("renders short names and descriptions in a compact hierarchy", () => {
    const root = node({
      uid: "root",
      name: "Full QA",
      description: "Repository verification",
      status: "wip",
      assignedSessionId: "019f7cd5-root",
      children: [
        node({
          uid: "scout",
          name: "Scout repository",
          description: "Locate relevant boundaries",
          status: "done",
          completedBySessionId: "019f7cd5-scout",
        }),
        node({ uid: "review", name: "Review findings", description: "Synthesize issues" }),
      ],
    });
    const summary: TaskSummary = { total: 3, notStarted: 1, wip: 1, done: 1 };
    assert.deepEqual(renderTaskTree(root, summary), [
      "Tasks · 1/3 done · 1 wip",
      "◐ Full QA — Repository verification · @019f7cd5",
      "├─ ✓ Scout repository — Locate relevant boundaries · @019f7cd5",
      "└─ ○ Review findings — Synthesize issues",
    ]);
  });

  it("autocompletes exact prefixes only for path and UID", () => {
    const references: TaskReference[] = [
      { uid: "task_123", path: "Root.Implementation.Transport", name: "Transport", status: "wip" },
      { uid: "task_456", path: "Root.Verification", name: "Verification", status: "not_started" },
    ];
    assert.deepEqual(
      taskCommandCompletions("log Root.Imp", references)?.map((item) => item.value),
      ["log Root.Implementation.Transport"],
    );
    assert.deepEqual(
      taskCommandCompletions("log task_1", references)?.map((item) => item.value),
      ["log task_123"],
    );
    assert.equal(taskCommandCompletions("log Transport", references), null);
  });
});
