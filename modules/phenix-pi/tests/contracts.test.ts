import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertOutputSchema, validateSchema } from "../extensions/phenix-contracts/validator.ts";

describe("Phenix handoff contracts", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "files"],
    properties: {
      summary: { type: "string", minLength: 1 },
      files: { type: "array", items: { type: "string" } },
    },
  };

  it("accepts valid structured handoffs", () => {
    assertOutputSchema(schema);
    assert.deepEqual(validateSchema(schema, { summary: "done", files: ["a.ts"] }), { ok: true });
  });

  it("returns precise validation failures", () => {
    const result = validateSchema(schema, { summary: "" });
    assert.equal(result.ok, false);
    if (!result.ok && "summary" in result) {
      assert.match(result.summary, /summary|files/);
      assert.ok(result.violations.length >= 1);
    }
  });

  it("rejects remote schema references", () => {
    assert.throws(
      () => assertOutputSchema({ $ref: "https://example.com/schema.json" }),
      /remote output-schema/,
    );
  });
});
