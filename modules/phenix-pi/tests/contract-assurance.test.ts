import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assuranceForContract } from "../packages/phenix-suite/runtime/contract-assurance.ts";
import type { ContractArtifact } from "../packages/phenix-suite/subagents/contract.ts";
import { resolveExecutionPolicy } from "../packages/phenix-suite/subagents/policy.ts";

function contract(input: {
  readonly role: ContractArtifact["identity"]["role"];
  readonly task: string;
  readonly criticRequired?: boolean;
  readonly commands?: readonly { readonly id: string; readonly command: string }[];
}): ContractArtifact {
  return {
    identity: { role: input.role },
    assignment: { task: input.task, requirements: [] },
    runtime: { workflow: { difficulty: "D2" } },
    verification: {
      commands: input.commands ?? [],
      criticRequired: input.criticRequired ?? false,
      maxRepairAttempts: 1,
    },
  } as unknown as ContractArtifact;
}

describe("contract assurance projection", () => {
  it("keeps an ordinary reviewed implementation at A2 without isolation", () => {
    assert.deepEqual(
      assuranceForContract(
        contract({
          role: "implementer",
          task: "Implement a bounded TypeScript change",
          criticRequired: true,
          commands: [{ id: "tests", command: "npm test" }],
        }),
      ),
      { assurance: "A2", isolationRequired: false },
    );
  });

  it("raises authentication and deployment work to isolated A3", () => {
    assert.deepEqual(
      assuranceForContract(
        contract({
          role: "implementer",
          task: "Update authentication deployment policy",
          criticRequired: true,
          commands: [{ id: "tests", command: "npm test" }],
        }),
      ),
      { assurance: "A3", isolationRequired: true },
    );
  });

  it("isolates a high-risk critic without recursively requiring another critic", () => {
    assert.deepEqual(
      assuranceForContract(
        contract({
          role: "critic",
          task: "Review authentication deployment policy",
        }),
      ),
      { assurance: "A3", isolationRequired: true },
    );

    const policy = resolveExecutionPolicy({
      role: "critic",
      task: "Review authentication deployment policy",
      requirements: [],
      cwd: process.cwd(),
      config: {
        verification: {
          maxRepairAttempts: 1,
          timeoutMs: 120_000,
        },
      },
    });
    assert.equal(policy.criticRequired, false);
  });
});
