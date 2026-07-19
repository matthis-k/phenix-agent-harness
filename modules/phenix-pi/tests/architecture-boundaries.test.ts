import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const suiteDir = path.resolve(testDir, "../packages/phenix-suite");

function moduleSpecifiers(file: string): readonly string[] {
  const source = fs.readFileSync(file, "utf-8");
  const specifiers = new Set<string>();
  const declarationPattern = /^\s*(?:import|export)\b[\s\S]*?;\s*$/gm;
  const dynamicImportPattern = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(declarationPattern)) {
    const declaration = match[0];
    const specifier = declaration.match(/(?:from\s+)?["']([^"']+)["']\s*;\s*$/)?.[1];
    if (specifier) specifiers.add(specifier);
  }

  for (const match of source.matchAll(dynamicImportPattern)) {
    if (match[1]) specifiers.add(match[1]);
  }

  return [...specifiers];
}

function assertNoDependencies(files: readonly string[], forbidden: readonly string[]): void {
  for (const file of files) {
    for (const specifier of moduleSpecifiers(file)) {
      assert.equal(
        forbidden.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)),
        false,
        `${path.relative(suiteDir, file)} must not import ${specifier}`,
      );
    }
  }
}

function suiteFiles(...relativePaths: string[]): readonly string[] {
  return relativePaths.map((relativePath) => path.join(suiteDir, relativePath));
}

describe("Phenix suite architecture boundaries", () => {
  it("keeps the public subagent API independent from workflow and Pi adapters", () => {
    assertNoDependencies(
      suiteFiles(
        "runtime/index.ts",
        "runtime/subagent-api.ts",
        "runtime/subagent-manager.ts",
        "runtime/subagent-manager-factory.ts",
        "runtime/execution-plan.ts",
        "runtime/session-options.ts",
        "runtime/session-subagent-adapter.ts",
      ),
      [
        "@matthis-k/phenix-flow",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
      ],
    );
  });

  it("keeps workflow compilation independent from routing and backend adapters", () => {
    assertNoDependencies(suiteFiles("subagents/workflow-execution-compiler.ts"), [
      "@matthis-k/phenix-routing",
      "../runtime/child-session-backend",
      "../runtime/sdk-child-session-backend",
    ]);
  });

  it("keeps workflow delegation independent from managed execution mechanics", () => {
    assertNoDependencies(suiteFiles("subagents/workflow-delegator.ts"), [
      "../runtime/child-session-backend",
      "../runtime/sdk-child-session-backend",
      "../runtime/subagent-session-runtime",
      "../runtime/subagent-manager",
      "../runtime/subagent-manager-factory",
      "./execution-quality-service",
      "./producer-cycle-runner",
    ]);
  });
});
