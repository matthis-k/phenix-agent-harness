import assert from "node:assert/strict";
import test from "node:test";

import { classifyDeterministicDispatch } from "../application/dispatch-service.ts";

test("routes full repository QA through workflow.qa", () => {
  assert.equal(classifyDeterministicDispatch("Do a full QA pass on this repository"), "qa");
});

test("routes concrete mutations through workflow.implement", () => {
  assert.equal(classifyDeterministicDispatch("Implement the requested API changes"), "implement");
});

test("routes mixed QA and repair through the dynamic coordinator", () => {
  assert.equal(classifyDeterministicDispatch("Audit the repository and fix every valid issue"), "coordinate");
});

test("leaves ambiguous substantial work for the typed dispatcher", () => {
  assert.equal(classifyDeterministicDispatch("Investigate the repository behavior"), undefined);
});
