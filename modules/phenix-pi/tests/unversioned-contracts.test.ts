import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const versionedContractId = /\b(?:request|outcome|tool)\.[a-z0-9.-]+\.v\d+\b/;
const versionedTypeName = /\b[A-Za-z_][A-Za-z0-9_]*V\d+\b/;

test("contract identifiers and interface names are unversioned", () => {
  const violations = sourceFiles(packageRoot).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((text, index) => ({
        file: path.relative(packageRoot, file),
        line: index + 1,
        text,
      }))
      .filter(({ text }) => versionedContractId.test(text) || versionedTypeName.test(text)),
  );

  assert.deepEqual(violations, []);
});

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(target);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".md"))
      ? [target]
      : [];
  });
}
