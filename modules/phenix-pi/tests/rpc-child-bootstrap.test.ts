import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  clearWorkflowDefinitions,
  getWorkflowDefinition,
} from "@matthis-k/phenix-flow/workflow-definitions.ts";
import { registerRpcChildWorkflowDefinitions } from "@matthis-k/phenix-suite/runtime/rpc-child-extension.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

function createAgentDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-rpc-bootstrap-"));
  temporaryDirectories.push(directory);
  process.env.PI_CODING_AGENT_DIR = directory;
  return directory;
}

afterEach(() => {
  clearWorkflowDefinitions();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("isolated RPC child bootstrap", () => {
  it("registers the default QA workflow before contract decoding", () => {
    createAgentDir();
    clearWorkflowDefinitions();

    assert.equal(getWorkflowDefinition("phenix-qa"), undefined);
    const registered = registerRpcChildWorkflowDefinitions();

    assert.ok(registered.includes("phenix-qa"));
    assert.equal(getWorkflowDefinition("phenix-qa")?.id, "phenix-qa");
  });

  it("registers configured workflows in the child module graph", () => {
    const agentDir = createAgentDir();
    const configDirectory = path.join(agentDir, "phenix");
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(configDirectory, "workflow.json"),
      JSON.stringify({
        id: "custom-rpc-workflow",
        initialState: "classified",
        transitions: [],
      }),
    );

    const registered = registerRpcChildWorkflowDefinitions();

    assert.ok(registered.includes("phenix-qa"));
    assert.ok(registered.includes("custom-rpc-workflow"));
    assert.equal(getWorkflowDefinition("custom-rpc-workflow")?.id, "custom-rpc-workflow");
  });
});
