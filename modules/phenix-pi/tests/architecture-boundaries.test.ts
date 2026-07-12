import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { modelSetRef } from "../extensions/phenix-kernel/refs.ts";
import { defaultContracts } from "../extensions/phenix-contracts/index.ts";
import { defaultAgentClients } from "../extensions/phenix-subagents/definitions.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "../extensions/phenix-routing/default-routing.ts";
import { definePhenixConfiguration } from "../extensions/phenix-composition/configuration.ts";
import { link } from "../extensions/phenix-composition/linker.ts";

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

function assertNoImport(sourceDir: string, forbidden: string): void {
  for (const file of readTsFiles(path.join(extensionsDir, sourceDir))) {
    const content = fs.readFileSync(file, "utf-8");
    assert.equal(
      content.includes(forbidden),
      false,
      `${path.relative(extensionsDir, file)} must not import ${forbidden}`,
    );
  }
}

describe("Phenix architecture boundaries", () => {
  it("routing does not import workflow or subagents", () => {
    assertNoImport("phenix-routing", "../phenix-workflow");
    assertNoImport("phenix-routing", "../phenix-subagents");
  });

  it("workflow does not import routing or subagents", () => {
    assertNoImport("phenix-workflow", "../phenix-routing");
    assertNoImport("phenix-workflow", "../phenix-subagents");
  });

  it("default declarative graph links", () => {
    const result = link(definePhenixConfiguration({
      activeModelSet: modelSetRef("mixed"),
      contracts: defaultContracts,
      agentClients: defaultAgentClients,
      routing: {
        modelSets: defaultModelSets,
        pools: defaultModelPools,
        agentRoutes: defaultAgentRoutes,
      },
      workflows: [],
      runtime: { sessionExecutionBackend: "external-process", maximumDelegationDepth: 3 },
    }));

    assert.equal(result.ok, true, result.ok ? undefined : result.diagnostics.map((d) => d.message).join("; "));
    if (result.ok) {
      assert.equal(result.graph.agentClients.has("coordinator" as never), true);
      assert.equal(result.graph.contracts.has("planner-handoff" as never), true);
    }
  });
});
