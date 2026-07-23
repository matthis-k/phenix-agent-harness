import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

describe("critic guidance", () => {
  it("does not reject QA output merely because the reviewed target has findings", () => {
    const path = fileURLToPath(new URL("../agents/critic.md", import.meta.url));
    const guidance = readFileSync(path, "utf8");

    assert.match(guidance, /judge whether the producer fulfilled the assigned task/i);
    assert.match(guidance, /review, audit, and QA assignments/i);
    assert.match(guidance, /negative findings are expected output/i);
    assert.match(guidance, /do not require target fixes unless.*requested implementation/i);
  });
});
