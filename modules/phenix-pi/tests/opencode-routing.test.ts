import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDefaultRoutingConfig } from "./support/default-routing-fixture.ts";

describe("OpenCode primary routes", () => {
  it("uses DeepSeek V4 Flash Free first", () => {
    const config = buildDefaultRoutingConfig();

    assert.equal(config.pools["free.universal"]?.[0], "opencode/deepseek-v4-flash-free");
  });

  it("keeps paid DeepSeek V4 behind the primary OpenCode Go candidates", () => {
    const config = buildDefaultRoutingConfig();

    for (const [poolName, candidates] of Object.entries(config.pools)) {
      if (!poolName.startsWith("go.")) continue;

      const deepSeekIndex = candidates.findIndex((candidate) =>
        candidate.includes("/deepseek-v4-"),
      );
      if (deepSeekIndex < 0) continue;

      assert.ok(deepSeekIndex > 0, `${poolName} routes through paid DeepSeek V4 first`);
    }
  });
});
