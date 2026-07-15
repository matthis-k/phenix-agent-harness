import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  returns,
  routing,
  type SubagentRequest,
} from "../extensions/phenix-runtime/child-session-backend.ts";

interface SummaryResult {
  readonly summary: string;
}

describe("public subagent API", () => {
  it("expresses task, return contract, and session selection without backend details", () => {
    const resultContract = returns<SummaryResult>(
      {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
      {
        name: "summary-result",
        decode: (value) => value as SummaryResult,
      },
    );

    const request: SubagentRequest<SummaryResult> = {
      task: "Summarize the routing boundary.",
      returns: resultContract,
      session: {
        agent: "scout",
        model: routing.get("scout"),
        thinking: "medium",
      },
    };

    assert.equal(request.task, "Summarize the routing boundary.");
    assert.equal(request.returns.name, "summary-result");
    assert.deepEqual(request.session?.model, {
      kind: "route",
      agent: "scout",
    });
    assert.deepEqual(request.returns.decode?.({ summary: "ok" }), {
      summary: "ok",
    });
    assert.equal("contractChannel" in request, false);
    assert.equal("workflowProjection" in request, false);
  });
});
