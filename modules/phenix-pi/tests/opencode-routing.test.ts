import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBundledConfig } from "../extensions/phenix-routing/config.ts";

describe("OpenCode Go primary routes", () => {
  it("keeps DeepSeek V4 behind a stable primary candidate", () => {
    const config = buildBundledConfig();

    for (const [poolName, candidates] of Object.entries(config.pools)) {
      if (!poolName.startsWith("go.")) continue;

      const deepSeekIndex = candidates.findIndex((candidate) =>
        candidate.includes("/deepseek-v4-"),
      );
      if (deepSeekIndex < 0) continue;

      assert.ok(deepSeekIndex > 0, `${poolName} routes through DeepSeek V4 first`);
    }
  });
});
