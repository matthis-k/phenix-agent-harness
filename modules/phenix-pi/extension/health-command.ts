import { existsSync } from "node:fs";

import type { IntegrationStatus } from "../adapters/pi-sdk/integrations.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import {
  PHENIX_MODEL_SETS,
  type PhenixModelSetId,
} from "../domain/definition/model.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";

export const PHENIX_HEALTH_TOPICS = [
  "integrations",
  "models",
  "definitions",
  "runtime",
  "storage",
] as const;

export type PhenixHealthTopic = (typeof PHENIX_HEALTH_TOPICS)[number];
export type PhenixHealthState = "healthy" | "degraded" | "unavailable" | "misconfigured";

export interface PhenixHealthCommand {
  readonly topic?: PhenixHealthTopic;
  readonly json: boolean;
}

export interface PhenixHealthSection {
  readonly topic: PhenixHealthTopic;
  readonly state: PhenixHealthState;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface PhenixHealthReport {
  readonly overall: PhenixHealthState;
  readonly sections: readonly PhenixHealthSection[];
}

export interface PhenixHealthInput {
  readonly runtime: PhenixRuntime;
  readonly rootRunId: RunId;
  readonly integrations: readonly IntegrationStatus[];
  readonly hasModelSet: (modelSet: PhenixModelSetId) => boolean;
  readonly timeoutMs?: number;
}

const STATE_RANK: Readonly<Record<PhenixHealthState, number>> = {
  healthy: 0,
  degraded: 1,
  unavailable: 2,
  misconfigured: 3,
};

export function parsePhenixHealthCommand(raw: string): PhenixHealthCommand | undefined {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  const json = tokens.includes("--json");
  const topics = tokens.filter((token) => token !== "--json");
  if (topics.length > 1 || tokens.some((token) => token !== "--json" && !isHealthTopic(token))) {
    return undefined;
  }
  return {
    ...(topics[0] ? { topic: topics[0] as PhenixHealthTopic } : {}),
    json,
  };
}

export async function inspectPhenixHealth(input: PhenixHealthInput): Promise<PhenixHealthReport> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const sections = await Promise.all([
    boundedSection("integrations", timeoutMs, () => integrationsHealth(input.integrations)),
    boundedSection("models", timeoutMs, () => modelsHealth(input)),
    boundedSection("definitions", timeoutMs, () => definitionsHealth(input)),
    boundedSection("runtime", timeoutMs, () => runtimeHealth(input)),
    boundedSection("storage", timeoutMs, () => storageHealth(input)),
  ]);
  return {
    overall: worstState(sections.map((section) => section.state)),
    sections,
  };
}

export function formatPhenixHealth(
  report: PhenixHealthReport,
  command: PhenixHealthCommand,
): string {
  if (command.json) {
    const selected = command.topic
      ? report.sections.find((section) => section.topic === command.topic)
      : report;
    return JSON.stringify(selected, null, 2);
  }

  if (command.topic) {
    const section = report.sections.find((candidate) => candidate.topic === command.topic);
    if (!section) return `Phenix health / ${command.topic}: UNAVAILABLE`;
    const lines = [
      `Phenix health / ${section.topic}: ${section.state.toUpperCase()}`,
      section.summary,
    ];
    if (section.details.length > 0) {
      lines.push("", ...section.details.map((detail) => `- ${detail}`));
    }
    return lines.join("\n");
  }

  return [
    `Phenix health: ${report.overall.toUpperCase()}`,
    ...report.sections.map(
      (section) => `${stateMark(section.state)} ${section.topic} — ${section.summary}`,
    ),
  ].join("\n");
}

export function healthNotificationLevel(report: PhenixHealthReport): "info" | "warning" {
  return report.overall === "healthy" ? "info" : "warning";
}

function isHealthTopic(value: string): value is PhenixHealthTopic {
  return (PHENIX_HEALTH_TOPICS as readonly string[]).includes(value);
}

async function boundedSection(
  topic: PhenixHealthTopic,
  timeoutMs: number,
  inspect: () => PhenixHealthSection | Promise<PhenixHealthSection>,
): Promise<PhenixHealthSection> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(inspect),
      new Promise<PhenixHealthSection>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              topic,
              state: "unavailable",
              summary: `health probe exceeded ${timeoutMs}ms`,
              details: [],
            }),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return {
      topic,
      state: "unavailable",
      summary: "health probe failed",
      details: [error instanceof Error ? error.message : String(error)],
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function integrationsHealth(statuses: readonly IntegrationStatus[]): PhenixHealthSection {
  if (statuses.length === 0) {
    return {
      topic: "integrations",
      state: "misconfigured",
      summary: "no integrations were registered",
      details: [],
    };
  }
  const loaded = statuses.filter((status) => status.state === "loaded");
  const failed = statuses.filter((status) => status.state === "failed");
  return {
    topic: "integrations",
    state: failed.length === 0 ? "healthy" : loaded.length === 0 ? "unavailable" : "degraded",
    summary: `${loaded.length}/${statuses.length} loaded`,
    details: statuses.map((status) =>
      status.state === "loaded"
        ? `${status.id}: loaded`
        : `${status.id}: failed${status.error ? ` — ${singleLine(status.error)}` : ""}`,
    ),
  };
}

async function modelsHealth(input: PhenixHealthInput): Promise<PhenixHealthSection> {
  const profile = await input.runtime.profiles.current(input.rootRunId);
  const available = PHENIX_MODEL_SETS.filter(input.hasModelSet);
  const missing = PHENIX_MODEL_SETS.filter((modelSet) => !input.hasModelSet(modelSet));
  const selectedAvailable = input.hasModelSet(profile.modelSet);
  const state: PhenixHealthState = !selectedAvailable
    ? "misconfigured"
    : available.length === 0
      ? "unavailable"
      : missing.length > 0
        ? "degraded"
        : "healthy";
  return {
    topic: "models",
    state,
    summary: `${available.length}/${PHENIX_MODEL_SETS.length} model sets available; selected ${profile.modelSet}`,
    details: PHENIX_MODEL_SETS.map(
      (modelSet) => `${modelSet}: ${input.hasModelSet(modelSet) ? "available" : "missing"}`,
    ),
  };
}

async function definitionsHealth(input: PhenixHealthInput): Promise<PhenixHealthSection> {
  const [diagnostics, available, tree] = await Promise.all([
    Promise.resolve(input.runtime.catalog.validateAll()),
    input.runtime.catalog.listAvailable(input.rootRunId),
    input.runtime.queries.runTree(input.rootRunId),
  ]);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const dynamicRuns = flattenRuns(tree.root)
    .filter((run) => run.compiled.dynamicWorkflow !== undefined);
  const drifted = dynamicRuns.filter(
    (run) =>
      run.outcome?.status === "failure" &&
      run.outcome.failure.code === "workflow_definition_drift",
  );
  const invalid = dynamicRuns.filter(
    (run) =>
      run.outcome?.status === "failure" &&
      run.outcome.failure.code === "workflow_definition_invalid",
  );
  const state: PhenixHealthState =
    errors.length > 0 || invalid.length > 0
      ? "misconfigured"
      : available.length === 0
        ? "unavailable"
        : warnings.length > 0 || drifted.length > 0
          ? "degraded"
          : "healthy";
  return {
    topic: "definitions",
    state,
    summary: `${available.length} root definitions; ${errors.length} errors, ${warnings.length} warnings`,
    details: [
      `dynamic workflows: ${dynamicRuns.length}; drifted: ${drifted.length}; invalid: ${invalid.length}`,
      ...diagnostics.map(
        (diagnostic) =>
          `${diagnostic.severity} ${diagnostic.code}${diagnostic.nodeId ? ` (${diagnostic.nodeId})` : ""}: ${diagnostic.message}`,
      ),
    ],
  };
}

async function runtimeHealth(input: PhenixHealthInput): Promise<PhenixHealthSection> {
  const [root, active, diagnostics] = await Promise.all([
    input.runtime.execution.inspect(input.rootRunId),
    input.runtime.queries.activeRuns(input.rootRunId),
    input.runtime.diagnostics.summary(input.rootRunId),
  ]);
  const state: PhenixHealthState = isTerminalRunState(root.state)
    ? "unavailable"
    : root.state === "running" || root.state === "waiting"
      ? "healthy"
      : "degraded";
  return {
    topic: "runtime",
    state,
    summary: `root ${root.state}; ${active.length} active runs; sequence ${input.runtime.sequence(input.rootRunId)}`,
    details: [
      `diagnostics: ${diagnostics.counts.error} errors, ${diagnostics.counts.warning} warnings, ${diagnostics.total} total`,
      ...active.map((run) => `${run.id}: ${run.definitionId} ${run.state}`),
    ],
  };
}

async function storageHealth(input: PhenixHealthInput): Promise<PhenixHealthSection> {
  const diagnostics = await input.runtime.diagnostics.summary(input.rootRunId);
  const ledger = input.runtime.ledgerPath(input.rootRunId);
  const log = input.runtime.diagnostics.pathFor(input.rootRunId);
  const artifacts = input.runtime.diagnostics.artifactDirectoryFor(input.rootRunId);
  const missingConfiguration = [ledger, log].some((value) => value === undefined);
  const missingRequired =
    (ledger !== undefined && !existsSync(ledger)) ||
    (log !== undefined && !existsSync(log)) ||
    (diagnostics.artifacts > 0 && (artifacts === undefined || !existsSync(artifacts)));
  const state: PhenixHealthState = missingConfiguration
    ? "misconfigured"
    : missingRequired
      ? "unavailable"
      : "healthy";
  return {
    topic: "storage",
    state,
    summary: `${diagnostics.total} diagnostic entries; ${diagnostics.artifacts} artifacts`,
    details: [
      `ledger: ${pathState(ledger)}`,
      `diagnostics: ${pathState(log)}`,
      `artifacts: ${artifacts ? pathState(artifacts) : diagnostics.artifacts === 0 ? "not created (empty)" : "not configured"}`,
    ],
  };
}

function flattenRuns(node: { readonly run: RunRecord; readonly children: readonly unknown[] }): RunRecord[] {
  const children = node.children as readonly {
    readonly run: RunRecord;
    readonly children: readonly unknown[];
  }[];
  return [node.run, ...children.flatMap(flattenRuns)];
}

function worstState(states: readonly PhenixHealthState[]): PhenixHealthState {
  return states.reduce(
    (worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst),
    "healthy",
  );
}

function stateMark(state: PhenixHealthState): string {
  if (state === "healthy") return "✓";
  if (state === "degraded") return "!";
  return "✗";
}

function pathState(value: string | undefined): string {
  if (!value) return "not configured";
  return `${value} (${existsSync(value) ? "present" : "missing"})`;
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}…`;
}
