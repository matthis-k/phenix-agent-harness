import assert from "node:assert/strict";
import test from "node:test";

import { renderStructuredContentMarkdown } from "../application/structured-content-markdown.ts";

test("ordered lists emit explicit sibling numbers and reset for nested lists", () => {
  const markdown = renderStructuredContentMarkdown({
    contentType: "document",
    children: [
      {
        contentType: "ordered-list",
        children: [
          { contentType: "list-item", content: "First" },
          {
            contentType: "list-item",
            content: "Second",
            children: [
              {
                contentType: "ordered-list",
                children: [
                  { contentType: "list-item", content: "Nested first" },
                  { contentType: "list-item", content: "Nested second" },
                ],
              },
            ],
          },
          { contentType: "list-item", content: "Third" },
        ],
      },
    ],
  });

  assert.equal(
    markdown,
    ["1. First", "2. Second", "  1. Nested first", "  2. Nested second", "3. Third"].join("\n"),
  );
  assert.doesNotMatch(markdown, /^0\./m);
});
