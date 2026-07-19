import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { METRICS_ANALYZER, parseFtaJson } from "../skills/phenix-qa/runtime/analyzers/metrics.ts";
import { DEFAULT_QA_CONFIG } from "../skills/phenix-qa/runtime/config.ts";
import { resetIdCounter } from "../skills/phenix-qa/runtime/normalize.ts";

describe("FTA metrics analyzer", () => {
  it("normalizes structured FTA output into summaries and threshold violations", () => {
    resetIdCounter();
    const parsed = parseFtaJson(
      JSON.stringify([
        {
          file_name: "src/simple.ts",
          cyclo: 2,
          halstead: { volume: 10, difficulty: 2, effort: 20 },
          line_count: 12,
          fta_score: 22.5,
          assessment: "OK",
        },
        {
          file_name: "src/complex.ts",
          cyclo: 14,
          halstead: { volume: 80, difficulty: 8, effort: 640 },
          line_count: 90,
          fta_score: 71.25,
          assessment: "Needs improvement",
        },
      ]),
      "/repo",
      10,
    );

    assert.equal(parsed.filesAnalyzed, 2);
    assert.deepEqual(
      parsed.evidence.map((item) => item.metric?.name),
      [
        "averageCyclomaticComplexity",
        "maxCyclomaticComplexity",
        "maxFtaScore",
        "maxHalsteadVolume",
        "cyclomaticComplexity",
      ],
    );
    const violation = parsed.evidence.at(-1);
    assert.equal(violation?.locations[0]?.path, "src/complex.ts");
    assert.equal(violation?.metric?.value, 14);
    assert.equal(violation?.metric?.threshold, 10);
  });

  it("rejects malformed FTA output instead of silently fabricating metrics", () => {
    assert.throws(
      () => parseFtaJson(JSON.stringify([{ file_name: "src/broken.ts", cyclo: "high" }]), "/repo"),
      /halstead must be an object|cyclo must be a finite number/,
    );
  });

  it("runs the packaged FTA executable against packaged TypeScript sources", async (t) => {
    const cwd = fileURLToPath(new URL("../skills/phenix-qa/runtime/analyzers", import.meta.url));
    const artifactRoot = mkdtempSync(join(tmpdir(), "phenix-qa-fta-artifacts-"));
    const artifactDirectory = join(artifactRoot, "nested", "artifacts");
    t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));

    const availability = await METRICS_ANALYZER.checkAvailability({
      cwd,
      scope: { kind: "repository", description: "FTA integration test" },
      artifactDirectory,
      config: DEFAULT_QA_CONFIG,
    });
    assert.equal(availability.available, true, availability.reason);
    assert.match(availability.executable ?? "", /fta$/);
    assert.equal(availability.version, "3.0.0");

    const result = await METRICS_ANALYZER.run({
      cwd,
      scope: { kind: "repository", description: "FTA integration test" },
      artifactDirectory,
      config: {
        ...DEFAULT_QA_CONFIG,
        thresholds: {
          ...DEFAULT_QA_CONFIG.thresholds,
          cyclomaticComplexity: 2,
        },
      },
    });

    assert.equal(result.status, "completed", result.diagnostics.join("\n"));
    assert.equal(result.artifacts.length, 1);
    assert.ok(result.evidence.some((item) => item.metric?.name === "maxCyclomaticComplexity"));
    assert.ok(result.evidence.some((item) => item.metric?.name === "cyclomaticComplexity"));
  });
});
