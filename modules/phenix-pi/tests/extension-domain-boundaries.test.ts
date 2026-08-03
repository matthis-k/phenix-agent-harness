import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CASES = [
  {
    file: "../extension/workspace/views/runs-view.ts",
    required: ['from "../../../application/workspace/views/runs-view.ts"'],
    forbidden: ["function visit(", "const visit =", "TERMINAL_STATES"],
  },
  {
    file: "../extension/workspace/views/objectives-view.ts",
    required: ['from "../../../application/workspace/views/objectives-view.ts"'],
    forbidden: ["function visit(", "const visit =", "objectiveStateSymbol"],
  },
  {
    file: "../extension/workspace/views/files-view.ts",
    required: ['from "../../../application/workspace/views/files-view.ts"'],
    forbidden: ["new Map<", "for (const fact", "latestSequence"],
  },
  {
    file: "../extension/workspace/views/facts-view.ts",
    required: ['from "../../../application/workspace/views/facts-view.ts"'],
    forbidden: [".sort(", ".slice(", "compactTime"],
  },
] as const;

test("extension workspace adapters do not regain application decisions", async () => {
  for (const { file, required, forbidden } of CASES) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    for (const marker of required) {
      assert.match(source, new RegExp(escapePattern(marker)), `${file} must import ${marker}`);
    }
    for (const marker of forbidden) {
      assert.doesNotMatch(
        source,
        new RegExp(escapePattern(marker)),
        `${file} must not contain ${marker}`,
      );
    }
  }
});

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
