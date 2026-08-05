import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSelectedBranchTranscript,
  projectSessionTreeSnapshot,
  promptContent,
} from "../headless/acp-server.ts";

test("ACP prompt content preserves text and image blocks", () => {
  const prompt = promptContent([
    { type: "text", text: "inspect this" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
  assert.equal(prompt.text, "inspect this");
  assert.deepEqual(prompt.images, [{ data: "aGVsbG8=", mediaType: "image/png" }]);
});

test("session replay follows only the selected persistent branch", () => {
  const transcript = extractSelectedBranchTranscript({
    leafEntryId: "assistant-b",
    tree: {
      entries: [
        { id: "user", role: "user", content: "question" },
        { id: "assistant-a", parentId: "user", role: "assistant", content: "discarded" },
        { id: "assistant-b", parentId: "user", role: "assistant", content: "selected" },
      ],
    },
  });
  assert.deepEqual(
    transcript.map((block) => [block.role, block.text]),
    [
      ["user", "question"],
      ["assistant", "selected"],
    ],
  );
});

test("typed Phenix session tree projection includes recursive runs and objectives", () => {
  const projected = projectSessionTreeSnapshot(
    "tree-session",
    {
      rootRunId: "root",
      workspace: {
        tree: {
          root: {
            run: { id: "root", kind: "root", state: "running" },
            children: [
              {
                run: {
                  id: "child",
                  kind: "agent",
                  state: "completed",
                  observedModel: { provider: "openai", model: "gpt" },
                },
                children: [],
              },
            ],
          },
        },
        objectives: {
          roots: [
            {
              id: "objective-root",
              title: "Build ACP",
              effectiveState: "wip",
              children: [
                {
                  id: "objective-child",
                  title: "Project state",
                  effectiveState: "done",
                  children: [],
                },
              ],
            },
          ],
        },
      },
    },
    { id: "definition" },
  );
  assert.equal(projected.definition_id, "definition");
  assert.deepEqual(
    (projected.nodes as Array<{ id: string; parent: string | null }>).map((node) => [
      node.id,
      node.parent,
    ]),
    [
      ["root", null],
      ["child", "root"],
    ],
  );
  assert.deepEqual(
    (projected.objectives as Array<{ id: string; parent: string | null; state: string }>).map(
      (objective) => [objective.id, objective.parent, objective.state],
    ),
    [
      ["objective-root", null, "WorkInProgress"],
      ["objective-child", "objective-root", "Done"],
    ],
  );
});
