import assert from "node:assert/strict";
import test from "node:test";

import {
  filterWorkspaceSelectItems,
  type WorkspaceSelectDialogItem,
} from "../extension/workspace/workspace-select-dialog.ts";

const ITEMS: readonly WorkspaceSelectDialogItem<string>[] = [
  {
    id: "openai/gpt-5.6",
    label: "GPT-5.6",
    detail: "openai · reasoning",
    searchText: "codex",
    value: "openai/gpt-5.6",
  },
  {
    id: "anthropic/claude-sonnet",
    label: "Claude Sonnet",
    detail: "anthropic",
    value: "anthropic/claude-sonnet",
  },
];

test("filters dialog items across labels, details, ids, and search aliases", () => {
  assert.deepEqual(filterWorkspaceSelectItems(ITEMS, "openai reasoning"), [ITEMS[0]]);
  assert.deepEqual(filterWorkspaceSelectItems(ITEMS, "codex"), [ITEMS[0]]);
  assert.deepEqual(filterWorkspaceSelectItems(ITEMS, "claude"), [ITEMS[1]]);
});

test("returns the original ordered list for an empty query", () => {
  assert.equal(filterWorkspaceSelectItems(ITEMS, ""), ITEMS);
});
