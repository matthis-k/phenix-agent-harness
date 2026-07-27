import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

test("schema IDs are unversioned", () => {
  assert.equal(defineSchema("request.example", Type.Object({})).id, "request.example");
  assert.throws(
    () => defineSchema("request.example.v1", Type.Object({})),
    /Schema IDs must be unversioned/,
  );
  assert.throws(
    () => defineSchema("request.example-v2", Type.Object({})),
    /Schema IDs must be unversioned/,
  );
});
