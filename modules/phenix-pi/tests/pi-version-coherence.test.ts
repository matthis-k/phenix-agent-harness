import assert from "node:assert/strict";
import test from "node:test";

import { VERSION } from "@earendil-works/pi-coding-agent";

test("packaged Pi SDK matches the pinned runtime version", () => {
  assert.equal(VERSION, "0.80.10");
});
