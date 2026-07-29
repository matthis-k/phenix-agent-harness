import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATED_PRESENTERS = [
  "native-run-transcript-view.ts",
  "result-display.ts",
  "run-monitor.ts",
  "visualization-display.ts",
] as const;

const GENERIC_COMPONENTS = [
  "document-view.ts",
  "list-view.ts",
  "panel.ts",
  "terminal-view.ts",
  "tree-view.ts",
  "viewport.ts",
] as const;

test("migrated presenters do not construct ad hoc text containers", async () => {
  for (const file of MIGRATED_PRESENTERS) {
    const source = await readFile(new URL(`../extension/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bnew\s+(?:Container|Text)\s*\(/, file);
  }
});

test("generic presentation components remain free of Phenix domains", async () => {
  for (const file of GENERIC_COMPONENTS) {
    const source = await readFile(
      new URL(`../extension/components/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /\.\.\/(?:application|domain|ports)\//, file);
    assert.doesNotMatch(source, /phenix/i, file);
  }
});

test("compact monitor delegates hierarchy and collection rendering", async () => {
  const source = await readFile(new URL("../extension/run-monitor.ts", import.meta.url), "utf8");
  assert.match(source, /new TreeView<RunTreeNode>/);
  assert.match(source, /new ListView<RunFact>/);
  assert.match(source, /new DocumentView\(/);
  assert.doesNotMatch(source, /function appendNode\(/);
});
