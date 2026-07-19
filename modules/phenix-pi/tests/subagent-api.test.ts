import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Static, Type } from "typebox";

import {
  decodeReturnValue,
  returns,
  returnsWithDecoder,
  routing,
  type SubagentRequest,
} from "@matthis-k/phenix-suite/runtime/child-session-backend.ts";

const SummarySchema = Type.Object(
  {
    summary: Type.String(),
  },
  { additionalProperties: false },
);

type SummaryResult = Static<typeof SummarySchema>;

describe("public subagent API", () => {
  it("derives the output type from a TypeBox return schema", () => {
    const resultContract = returns(SummarySchema, {
      name: "summary-result",
    });

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
    assert.equal("contractChannel" in request, false);
    assert.equal("workflowProjection" in request, false);
  });

  it("requires an explicit decoder to type arbitrary JSON Schema", () => {
    const contract = returnsWithDecoder<SummaryResult>(
      {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
      (value) => value as SummaryResult,
    );

    assert.deepEqual(decodeReturnValue(contract, { summary: "ok" }), {
      summary: "ok",
    });
  });
});
