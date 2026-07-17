/**
 * Tests for QA evidence normalization.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fileLocation,
  makeEvidence,
  makeFinding,
  mapMetricToSeverity,
  mapSeverity,
  normalizeSarif,
  resetIdCounter,
} from "../skills/phenix-qa/runtime/normalize.ts";

describe("Evidence normalization", () => {
  it("creates evidence with auto-generated ID", () => {
    resetIdCounter(0);
    const ev = makeEvidence({
      level: "level-0-correctness",
      source: "test",
      category: "typecheck",
      message: "Passed",
    });
    assert.ok(ev.id);
    assert.match(ev.id, /^test-evidence-/);
    assert.equal(ev.level, "level-0-correctness");
    assert.equal(ev.source, "test");
    assert.equal(ev.category, "typecheck");
    assert.equal(ev.message, "Passed");
    assert.deepEqual(ev.locations, []);
  });

  it("preserves locations", () => {
    resetIdCounter(0);
    const ev = makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "complexity",
      message: "High complexity",
      locations: [{ path: "src/a.ts", startLine: 10, endLine: 20 }],
    });
    assert.equal(ev.locations.length, 1);
    assert.equal(ev.locations[0]!.path, "src/a.ts");
    assert.equal(ev.locations[0]!.startLine, 10);
  });

  it("preserves metrics", () => {
    resetIdCounter(0);
    const ev = makeEvidence({
      level: "level-1-metrics",
      source: "metric",
      category: "complexity",
      message: "Cyclomatic complexity: 25",
      metric: { name: "cyclomaticComplexity", value: 25, threshold: 20, unit: "count" },
    });
    assert.ok(ev.metric);
    assert.equal(ev.metric!.name, "cyclomaticComplexity");
    assert.equal(ev.metric!.value, 25);
    assert.equal(ev.metric!.threshold, 20);
  });

  it("preserves tool and ruleId", () => {
    resetIdCounter(0);
    const ev = makeEvidence({
      level: "level-3-patterns",
      source: "structural-rule",
      category: "pattern",
      message: "Rule violated",
      tool: "ast-grep",
      ruleId: "no-raw-subagent",
    });
    assert.equal(ev.tool, "ast-grep");
    assert.equal(ev.ruleId, "no-raw-subagent");
  });

  it("generates sequential IDs", () => {
    resetIdCounter(0);
    const ev1 = makeEvidence({
      level: "level-0-correctness",
      source: "test",
      category: "c",
      message: "m1",
    });
    const ev2 = makeEvidence({
      level: "level-0-correctness",
      source: "test",
      category: "c",
      message: "m2",
    });
    assert.notEqual(ev1.id, ev2.id);
    const num1 = parseInt(ev1.id.match(/\d+/)![0], 10);
    const num2 = parseInt(ev2.id.match(/\d+/)![0], 10);
    assert.equal(num2, num1 + 1);
  });
});

describe("Finding normalization", () => {
  it("creates finding with auto-generated ID", () => {
    resetIdCounter(0);
    const finding = makeFinding({
      level: "level-0-correctness",
      severity: "high",
      confidence: "high",
      title: "Build failure",
      explanation: "Build failed.",
      evidenceIds: ["ev-1"],
      impact: "Cannot deploy.",
      recommendation: "Fix errors.",
      remediationScope: "local",
    });
    assert.ok(finding.id);
    assert.match(finding.id, /^qa-finding-/);
    assert.equal(finding.severity, "high");
    assert.equal(finding.blocking, false);
  });

  it("creates blocking finding", () => {
    resetIdCounter(0);
    const finding = makeFinding({
      level: "level-0-correctness",
      severity: "critical",
      confidence: "high",
      title: "Critical bug",
      explanation: "Critical.",
      evidenceIds: ["ev-1"],
      impact: "Severe.",
      recommendation: "Fix.",
      remediationScope: "local",
      blocking: true,
    });
    assert.equal(finding.blocking, true);
    assert.equal(finding.introducedByCurrentChange, false);
  });
});

describe("Severity mapping", () => {
  it("maps error to critical", () => {
    assert.equal(mapSeverity("error"), "critical");
    assert.equal(mapSeverity("ERROR"), "critical");
    assert.equal(mapSeverity("fatal"), "critical");
  });

  it("maps warning to high", () => {
    assert.equal(mapSeverity("warning"), "high");
    assert.equal(mapSeverity("WARNING"), "high");
  });

  it("maps note to medium", () => {
    assert.equal(mapSeverity("note"), "medium");
    assert.equal(mapSeverity("moderate"), "medium");
  });

  it("maps minor to low", () => {
    assert.equal(mapSeverity("minor"), "low");
    assert.equal(mapSeverity("low"), "low");
  });

  it("maps info to info", () => {
    assert.equal(mapSeverity("info"), "info");
    assert.equal(mapSeverity("information"), "info");
  });

  it("maps unknown to medium", () => {
    assert.equal(mapSeverity("something-else"), "medium");
  });
});

describe("Metric-to-severity mapping", () => {
  it("below threshold is info", () => {
    assert.equal(mapMetricToSeverity(10, 20), "info");
  });

  it("at threshold is low", () => {
    assert.equal(mapMetricToSeverity(20, 20), "low");
  });

  it("1.5x threshold is medium", () => {
    assert.equal(mapMetricToSeverity(30, 20), "medium");
  });

  it("2x threshold is high", () => {
    assert.equal(mapMetricToSeverity(40, 20), "high");
  });

  it("3x threshold is critical", () => {
    assert.equal(mapMetricToSeverity(60, 20), "critical");
  });

  it("no threshold returns info", () => {
    assert.equal(mapMetricToSeverity(1000, undefined), "info");
  });
});

describe("Location helpers", () => {
  it("creates file location", () => {
    const loc = fileLocation("src/main.ts", 10, 20, "myFunc");
    assert.equal(loc.path, "src/main.ts");
    assert.equal(loc.startLine, 10);
    assert.equal(loc.endLine, 20);
    assert.equal(loc.symbol, "myFunc");
  });

  it("creates minimal location", () => {
    const loc = fileLocation("src/main.ts");
    assert.equal(loc.path, "src/main.ts");
    assert.equal(loc.startLine, undefined);
    assert.equal(loc.symbol, undefined);
  });
});

describe("SARIF normalization", () => {
  it("normalizes empty SARIF", () => {
    resetIdCounter(0);
    const result = normalizeSarif(
      { results: [] },
      "test-tool",
      "structural-rule",
      "level-3-patterns",
    );
    assert.deepEqual(result, []);
  });

  it("normalizes SARIF with results", () => {
    resetIdCounter(0);
    const sarif = {
      tool: { driver: { name: "semgrep", version: "1.0.0" } },
      results: [
        {
          ruleId: "test-rule-001",
          level: "error",
          message: { text: "Found an issue" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/test.ts" },
                region: { startLine: 10, endLine: 12 },
              },
            },
          ],
        },
      ],
    };
    const result = normalizeSarif(sarif, "semgrep", "security-tool", "level-7-security");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.ruleId, "test-rule-001");
    assert.equal(result[0]!.message, "Found an issue");
    assert.equal(result[0]!.locations[0]!.path, "src/test.ts");
    assert.equal(result[0]!.locations[0]!.startLine, 10);
    assert.equal(result[0]!.rawReference, "1.0.0");
  });

  it("normalizes SARIF with artifact index references", () => {
    resetIdCounter(0);
    const sarif = {
      artifacts: [{ location: { uri: "src/indexed.ts" }, index: 0 }],
      results: [
        {
          ruleId: "rule-1",
          message: {},
          locations: [
            {
              physicalLocation: {
                artifactLocation: { index: 0 },
                region: {},
              },
            },
          ],
        },
      ],
    };
    const result = normalizeSarif(sarif, "test", "structural-rule", "level-3-patterns");
    assert.equal(result.length, 1);
    assert.equal(result[0]!.locations[0]!.path, "src/indexed.ts");
  });
});
