import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionsDir = path.resolve(testDir, "../extensions");

function readExtension(relativePath: string): string {
  return fs.readFileSync(path.join(extensionsDir, relativePath), "utf-8");
}

describe("workflow child-session composition", () => {
  it("starts producer sessions through the declarative session runtime", () => {
    const coordinator = readExtension("phenix-subagents/coordinator.ts");

    assert.match(coordinator, /private readonly sessionRuntime: SubagentSessionRuntime;/);
    assert.match(coordinator, /this\.sessionRuntime\.spawn\(sessionRequest, runSignal\)/);
    assert.match(coordinator, /modelSet: modelSetId\(selectedModelSet\)/);
    assert.match(coordinator, /difficulty: wfRecord\.difficulty/);

    const producerStart = coordinator.indexOf(
      "this.sessionRuntime.spawn(sessionRequest, runSignal)",
    );
    const criticStart = coordinator.indexOf("private async runCritic");
    assert.ok(producerStart >= 0);
    assert.ok(criticStart > producerStart);
    assert.equal(
      coordinator.slice(0, criticStart).includes("this.backend.start(spec, runSignal)"),
      false,
    );
  });

  it("wires canonical routing into the shared session facade", () => {
    const composition = readExtension("phenix.ts");

    assert.match(composition, /const sessionRuntime = createSubagentSessionRuntime\(/);
    assert.match(composition, /resolveChildRoute\(\{ modelSet, role: agent, difficulty \}\)/);
    assert.match(composition, /new AgentExecutionCoordinator\(\{[\s\S]*?sessionRuntime,/);
  });
});
