import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunSnapshot } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import {
  formatPhenixHealth,
  healthNotificationLevel,
  inspectPhenixHealth,
  parsePhenixHealthCommand,
} from "../extension/health-command.ts";

const rootRunId = "root-health" as RunId;
const rootSnapshot = {
  id: rootRunId,
  kind: "root",
  definitionId: "root.session",
  input: {},
  outputSchemaId: "outcome.base",
  requestedAt: "2026-01-01T00:00:00.000Z",
  ownership: "attached",
  state: "running",
  revision: 1,
  compiled: { dynamicWorkflow: undefined },
  activeChildren: [],
} as unknown as RunSnapshot;

function runtimeFixture(input: {
  readonly ledger: string;
  readonly diagnostics: string;
  readonly profile?: Promise<{ readonly modelSet: "mixed" }>;
}): PhenixRuntime {
  return {
    profiles: {
      current: () => input.profile ?? Promise.resolve({ modelSet: "mixed" }),
    },
    catalog: {
      validateAll: () => [],
      listAvailable: async () => [
        {
          id: "workflow.qa",
          kind: "workflow",
          title: "QA",
          description: "QA",
          inputSchema: "request.objective",
          outputSchema: "outcome.qa-report",
        },
      ],
    },
    queries: {
      runTree: async () => ({ root: { run: rootSnapshot, children: [] } }),
      activeRuns: async () => [rootSnapshot],
    },
    execution: {
      inspect: async () => rootSnapshot,
    },
    diagnostics: {
      summary: async () => ({
        total: 0,
        artifacts: 0,
        counts: { trace: 0, info: 0, warning: 0, error: 0 },
      }),
      pathFor: () => input.diagnostics,
      artifactDirectoryFor: () => undefined,
    },
    sequence: () => 7,
    ledgerPath: () => input.ledger,
  } as unknown as PhenixRuntime;
}

test("health command parser accepts one topic and optional JSON", () => {
  assert.deepEqual(parsePhenixHealthCommand(""), { json: false });
  assert.deepEqual(parsePhenixHealthCommand("models --json"), {
    topic: "models",
    json: true,
  });
  assert.deepEqual(parsePhenixHealthCommand("--json storage"), {
    topic: "storage",
    json: true,
  });
  assert.equal(parsePhenixHealthCommand("models runtime"), undefined);
  assert.equal(parsePhenixHealthCommand("unknown"), undefined);
});

test("health report is compact globally and detailed by topic", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "phenix-health-"));
  const ledger = path.join(directory, "events.jsonl");
  const diagnostics = path.join(directory, "logs.jsonl");
  writeFileSync(ledger, "");
  writeFileSync(diagnostics, "");

  try {
    const report = await inspectPhenixHealth({
      runtime: runtimeFixture({ ledger, diagnostics }),
      rootRunId,
      integrations: [
        { id: "hypa", state: "loaded" },
        { id: "lsp", state: "loaded" },
        { id: "mcp", state: "loaded" },
        { id: "context", state: "loaded" },
        { id: "web", state: "loaded" },
      ],
      hasModelSet: () => true,
    });

    assert.equal(report.overall, "healthy");
    assert.equal(healthNotificationLevel(report), "info");
    assert.match(formatPhenixHealth(report, { json: false }), /Phenix health: HEALTHY/);
    assert.match(formatPhenixHealth(report, { json: false }), /✓ storage/);
    assert.match(
      formatPhenixHealth(report, { topic: "runtime", json: false }),
      /root running; 1 active runs; sequence 7/,
    );
    assert.deepEqual(
      JSON.parse(formatPhenixHealth(report, { topic: "models", json: true })),
      report.sections.find((section) => section.topic === "models"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a timed-out topic becomes unavailable without blocking other probes", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "phenix-health-timeout-"));
  const ledger = path.join(directory, "events.jsonl");
  const diagnostics = path.join(directory, "logs.jsonl");
  writeFileSync(ledger, "");
  writeFileSync(diagnostics, "");

  try {
    const report = await inspectPhenixHealth({
      runtime: runtimeFixture({
        ledger,
        diagnostics,
        profile: new Promise(() => undefined),
      }),
      rootRunId,
      integrations: [{ id: "hypa", state: "loaded" }],
      hasModelSet: () => true,
      timeoutMs: 5,
    });

    assert.equal(
      report.sections.find((section) => section.topic === "models")?.state,
      "unavailable",
    );
    assert.equal(
      report.sections.find((section) => section.topic === "integrations")?.state,
      "healthy",
    );
    assert.equal(healthNotificationLevel(report), "warning");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
