import assert from "node:assert/strict";
import test from "node:test";

import { defaultMemoryPolicy, defineMemoryPolicy } from "../domain/memory/policy.ts";

test("freezes the complete memory policy after validation", () => {
  assert.equal(Object.isFrozen(defaultMemoryPolicy), true);
  assert.equal(Object.isFrozen(defaultMemoryPolicy.context), true);
  assert.equal(Object.isFrozen(defaultMemoryPolicy.storage), true);
  assert.equal(Object.isFrozen(defaultMemoryPolicy.storage.retentionDays), true);
});

test("rejects overlapping context-folding thresholds", () => {
  assert.throws(
    () =>
      defineMemoryPolicy({
        ...defaultMemoryPolicy,
        context: {
          ...defaultMemoryPolicy.context,
          foldAtRatio: 0.9,
          aggressiveFoldAtRatio: 0.8,
        },
      }),
    /foldAtRatio must be below aggressiveFoldAtRatio/,
  );
});

test("rejects an aggressive protected tail larger than the normal tail", () => {
  assert.throws(
    () =>
      defineMemoryPolicy({
        ...defaultMemoryPolicy,
        context: {
          ...defaultMemoryPolicy.context,
          recentMessageTail: 4,
          aggressiveMessageTail: 5,
        },
      }),
    /aggressiveMessageTail must not exceed recentMessageTail/,
  );
});

test("rejects zero and negative storage limits or retention periods", () => {
  assert.throws(
    () =>
      defineMemoryPolicy({
        ...defaultMemoryPolicy,
        storage: { ...defaultMemoryPolicy.storage, maximumEvidenceBytes: 0 },
      }),
    /maximumEvidenceBytes must be a positive integer/,
  );
  assert.throws(
    () =>
      defineMemoryPolicy({
        ...defaultMemoryPolicy,
        storage: {
          ...defaultMemoryPolicy.storage,
          retentionDays: { ...defaultMemoryPolicy.storage.retentionDays, ephemeral: 0 },
        },
      }),
    /retentionDays.ephemeral must be a positive integer/,
  );
});
