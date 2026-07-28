import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const trackedSources = execFileSync("git", ["grep", "-Il", "", "--", "*.ts", "*.md"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const versionedContractId = /\b(?:request|outcome|tool)\.[a-z0-9.-]+\.v\d+\b/;
const versionedTypeName = /\b[A-Za-z_][A-Za-z0-9_]*V\d+\b/;

test("contract identifiers and interface names are unversioned", () => {
  const violations = trackedSources.flatMap((file) => {
    const content = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" });
    return content
      .split("\n")
      .map((line, index) => ({ file, line: index + 1, text: line }))
      .filter(({ text }) => versionedContractId.test(text) || versionedTypeName.test(text));
  });

  assert.deepEqual(violations, []);
});
