import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { definePhenixConfiguration } from "../extensions/phenix-composition/configuration.ts";
import { link } from "../extensions/phenix-composition/linker.ts";
import { defaultContracts } from "../extensions/phenix-contracts/index.ts";
import { modelSetRef } from "../extensions/phenix-kernel/refs.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "../extensions/phenix-routing/default-routing.ts";
import { defaultAgentClients } from "../extensions/phenix-subagents/definitions.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionsDir = path.resolve(testDir, "../extensions");

function readTsFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTsFiles(full));
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Extract module specifiers from static import/export declarations and dynamic
 * imports. This inspects dependency syntax rather than arbitrary source text,
 * so comments, diagnostics, and documentation cannot trigger a false boundary
 * failure.
 */
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
        `${path.relative(extensionsDir, file)} must not import ${specifier}`,
      );
    }
  }
}

function filesIn(relativeDir: string): readonly string[] {
  return readTsFiles(path.join(extensionsDir, relativeDir));
}

function selectedFiles(...relativePaths: string[]): readonly string[] {
  return relativePaths.map((relativePath) => path.join(extensionsDir, relativePath));
}

describe("Phenix architecture boundaries", () => {
  it("keeps routing independent from workflow and subagent orchestration", () => {
    assertNoDependencies(filesIn("phenix-routing"), ["../phenix-workflow", "../phenix-subagents"]);
  });

  it("keeps workflow independent from routing and subagent orchestration", () => {
    assertNoDependencies(filesIn("phenix-workflow"), ["../phenix-routing", "../phenix-subagents"]);
  });

  it("keeps the public subagent API independent from workflows and Pi", () => {
    assertNoDependencies(
      selectedFiles(
        "phenix-runtime/index.ts",
        "phenix-runtime/subagent-api.ts",
        "phenix-runtime/subagent-manager.ts",
        "phenix-runtime/execution-plan.ts",
        "phenix-runtime/session-options.ts",
        "phenix-runtime/session-subagent-adapter.ts",
      ),
      [
        "../phenix-workflow",
        "../phenix-subagents",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
      ],
    );
  });

  it("keeps workflow compilation independent from routing and backend adapters", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/workflow-execution-compiler.ts"), [
      "../phenix-routing",
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
    ]);
  });

  it("keeps the coordinator independent from the Pi SDK adapter", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/sdk-child-session-backend",
    ]);
  });

  it("links the default declarative graph", () => {
    const result = link(
      definePhenixConfiguration({
        activeModelSet: modelSetRef("mixed"),
        contracts: defaultContracts,
        agentClients: defaultAgentClients,
        routing: {
          modelSets: defaultModelSets,
          pools: defaultModelPools,
          agentRoutes: defaultAgentRoutes,
        },
        workflows: [],
        runtime: {
          childSessionBackend: "sdk",
          maximumDelegationDepth: 3,
          persistChildSessions: true,
        },
      }),
    );

    assert.equal(
      result.ok,
      true,
      result.ok ? undefined : result.diagnostics.map((diagnostic) => diagnostic.message).join("; "),
    );
    if (result.ok) {
      assert.equal(result.graph.agentClients.has("coordinator" as never), true);
      assert.equal(result.graph.contracts.has("planner-handoff" as never), true);
    }
  });
});
