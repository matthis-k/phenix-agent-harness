import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runVerificationCommands } from "../extensions/phenix-subagents/verification.ts";

function nodeCommand(source: string): string {
  const quoted = JSON.stringify(source);
  return `${JSON.stringify(process.execPath)} -e ${quoted}`;
}

describe("Phenix runtime verification", () => {
  it("executes configured checks outside the model", async () => {
    const results = await runVerificationCommands(
      [{ id: "pass", command: nodeCommand("process.stdout.write('ok')") }],
      process.cwd(),
      new AbortController().signal,
    );
    assert.equal(results[0]?.status, "passed");
    assert.equal(results[0]?.stdout, "ok");
  });

  it("returns concrete failure output for repair feedback", async () => {
    const results = await runVerificationCommands(
      [{ id: "fail", command: nodeCommand("process.stderr.write('broken'); process.exit(7)") }],
      process.cwd(),
      new AbortController().signal,
    );
    assert.equal(results[0]?.status, "failed");
    assert.equal(results[0]?.exitCode, 7);
    assert.equal(results[0]?.stderr, "broken");
  });
});
