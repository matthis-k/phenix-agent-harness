import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contractRuntimeBlock,
  injectContractRuntimeBlock,
  stripContractRuntimeBlocks,
} from "../extensions/phenix-subagents/contract-prompt.ts";
import {
  createRunId,
  issueContract,
} from "../extensions/phenix-subagents/contract.ts";

const TEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { const: true } },
};

function createTestContract() {
  const runId = createRunId();
  return issueContract({
    runId,
    role: "scout",
    task: "gather evidence",
    requirements: ["requirement 1"],
    outputSchema: TEST_SCHEMA,
  });
}

describe("Contract prompt", () => {
  it("block injection produces valid block", () => {
    const artifact = createTestContract().artifact;
    const block = contractRuntimeBlock(artifact);
    assert(block.includes("<phenix-contract-runtime"));
    assert(block.includes(`contract="${artifact.id}"`));
    assert(block.includes("phenix_contract_get"));
    assert(block.includes("phenix_contract_submit"));
    assert(block.includes("</phenix-contract-runtime>"));
  });

  it("injected block is stripped correctly", () => {
    const artifact = createTestContract().artifact;
    const injected = injectContractRuntimeBlock("original task", artifact);
    assert(injected.includes("original task"));
    assert(injected.includes(`contract="${artifact.id}"`));

    const stripped = stripContractRuntimeBlocks(injected);
    assert(!stripped.includes("<phenix-contract-runtime"));
    assert(!stripped.includes(`contract="${artifact.id}"`));
    assert(stripped.includes("original task"));
  });

  it("existing block is replaced, not duplicated", () => {
    const first = createTestContract().artifact;
    const second = createTestContract().artifact;

    const injected = injectContractRuntimeBlock("original task", first);
    const replaced = injectContractRuntimeBlock(injected, second);

    // Should only contain the second contract's block
    const blockCount = (replaced.match(/<phenix-contract-runtime/g) ?? []).length;
    assert.equal(blockCount, 1);
    assert(replaced.includes(`contract="${second.id}"`));
    assert(!replaced.includes(`contract="${first.id}"`));
  });

  it("nested contract strips parent ID", () => {
    const parent = createTestContract().artifact;
    const child = createTestContract().artifact;

    const parentTask = injectContractRuntimeBlock("parent work", parent);
    const childTask = injectContractRuntimeBlock(parentTask, child);

    assert(childTask.includes(`contract="${child.id}"`));
    assert(!childTask.includes(`contract="${parent.id}"`));
    assert(childTask.includes("parent work"));
  });

  it("ordinary text outside the block remains unchanged", () => {
    const artifact = createTestContract().artifact;
    const task = "Here is some context.\n\nSome more text.\n\nFinal thoughts.";
    const injected = injectContractRuntimeBlock(task, artifact);

    assert(injected.includes("Here is some context."));
    assert(injected.includes("Some more text."));
    assert(injected.includes("Final thoughts."));
    assert(injected.includes("<phenix-contract-runtime"));

    const stripped = stripContractRuntimeBlocks(injected);
    assert(stripped.includes("Here is some context."));
    assert(stripped.includes("Some more text."));
    assert(stripped.includes("Final thoughts."));
    assert(!stripped.includes("<phenix-contract-runtime"));
  });

  it("stripContractRuntimeBlocks returns same text when no block exists", () => {
    const text = "Just some text without any contract block.";
    assert.equal(stripContractRuntimeBlocks(text), text);
  });

  it("multiple blocks are all stripped", () => {
    const c1 = createTestContract().artifact;
    const c2 = createTestContract().artifact;
    const text = `${contractRuntimeBlock(c1)}\n\nsome content\n\n${contractRuntimeBlock(c2)}`;
    const stripped = stripContractRuntimeBlocks(text);
    assert(!stripped.includes("<phenix-contract-runtime"));
    assert(stripped.includes("some content"));
  });
});
