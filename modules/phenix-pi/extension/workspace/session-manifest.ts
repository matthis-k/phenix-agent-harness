import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  copyToClipboard,
  type ExtensionCommandContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { RunTreeNode } from "../../application/interfaces.ts";
import type { DiagnosticLogEntry } from "../../domain/diagnostics.ts";
import type { RunId } from "../../domain/shared.ts";
import type { WorkspaceRuntimeBinding } from "../workspace-runtime-binding.ts";

export interface SessionManifestCommand {
  readonly file?: string;
}

export function parseSessionManifestCommand(text: string): SessionManifestCommand | undefined {
  const trimmed = text.trim();
  const match = /^\/session\s+copy(?:\s+--file(?:\s+(.+))?)?$/u.exec(trimmed);
  if (!match) return undefined;
  const requested = match[1]?.trim();
  return requested ? { file: stripMatchingQuotes(requested) } : {};
}

export function isSessionManifestCommand(text: string): boolean {
  return parseSessionManifestCommand(text) !== undefined;
}

export async function copySessionManifest(
  ctx: ExtensionCommandContext,
  binding: WorkspaceRuntimeBinding | undefined,
  commandText: string,
): Promise<void> {
  if (!binding) throw new Error("Phenix runtime is not initialized");
  const command = parseSessionManifestCommand(commandText);
  if (!command) throw new Error(`Invalid session-copy command: ${commandText}`);

  const manifest = await buildSessionManifest(ctx, binding);
  const text = `${stringifyManifest(manifest)}\n`;
  const file = manifestFile(ctx.cwd, binding, command.file);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);

  try {
    await copyToClipboard(text);
    ctx.ui.notify(`Copied the complete session manifest and wrote ${file}`, "info");
  } catch (error) {
    ctx.ui.notify(
      `Wrote the complete session manifest to ${file}; clipboard copy failed: ${describeError(error)}`,
      "warning",
    );
  }
}

export async function buildSessionManifest(
  ctx: ExtensionCommandContext,
  binding: WorkspaceRuntimeBinding,
): Promise<Readonly<Record<string, unknown>>> {
  const { runtime, rootRunId } = binding;
  const [
    runTree,
    activeRuns,
    facts,
    diagnostics,
    diagnosticSummary,
    profile,
    objectives,
    projects,
    memory,
  ] = await Promise.all([
    runtime.queries.runTree(rootRunId),
    runtime.queries.activeRuns(rootRunId),
    runtime.queries.facts(rootRunId),
    runtime.diagnostics.entries(rootRunId, "trace"),
    runtime.diagnostics.summary(rootRunId),
    runtime.profiles.current(rootRunId),
    runtime.objectives.tree(rootRunId),
    runtime.projects.list(),
    runtime.memory.snapshot(rootRunId),
  ]);
  const nodes = flattenRunTree(runTree.root);
  const ledgerPath = runtime.ledgerPath(rootRunId);
  const diagnosticPath = runtime.diagnostics.pathFor(rootRunId);
  const diagnosticArtifacts = await resolveDiagnosticArtifacts(
    runtime.diagnostics,
    rootRunId,
    diagnostics,
  );
  const childSessions = await Promise.all(
    nodes
      .filter((node) => node.run.kind === "agent" && node.run.pi !== undefined)
      .map((node) => loadChildSession(binding, node)),
  );

  return {
    generatedAt: new Date().toISOString(),
    root: {
      runId: rootRunId,
      sequence: runtime.sequence(rootRunId),
      integrations: binding.integrations,
      profile,
      ledgerPath: ledgerPath ?? null,
      diagnosticPath: diagnosticPath ?? null,
      diagnosticArtifactDirectory: runtime.diagnostics.artifactDirectoryFor(rootRunId) ?? null,
      session: {
        id: ctx.sessionManager.getSessionId(),
        name: ctx.sessionManager.getSessionName() ?? null,
        file: ctx.sessionManager.getSessionFile() ?? null,
        cwd: ctx.sessionManager.getCwd(),
        leafId: ctx.sessionManager.getLeafId() ?? null,
        header: ctx.sessionManager.getHeader() ?? null,
      },
    },
    runTree,
    activeRuns,
    objectives,
    projects,
    memory,
    pendingUserForms: runtime.userForms.list(rootRunId),
    facts,
    diagnostics: {
      summary: diagnosticSummary,
      entries: diagnostics,
      artifacts: diagnosticArtifacts,
    },
    events: await readJsonl(ledgerPath),
    sessions: {
      root: {
        runId: rootRunId,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        entries: ctx.sessionManager.getEntries(),
        tree: ctx.sessionManager.getTree(),
        activeBranch: ctx.sessionManager.getBranch(),
      },
      children: childSessions,
    },
  };
}

async function loadChildSession(
  binding: WorkspaceRuntimeBinding,
  node: RunTreeNode,
): Promise<Readonly<Record<string, unknown>>> {
  const reference = node.run.pi;
  if (!reference) throw new Error(`Run ${node.run.id} has no Pi session reference`);
  const live = binding.runtime.transcripts.get(node.run.id);
  let entries: readonly unknown[] | undefined;
  let loadError: string | undefined;

  if (reference.sessionFile) {
    try {
      entries = SessionManager.open(reference.sessionFile).getEntries();
    } catch (error) {
      loadError = describeError(error);
    }
  }

  return {
    runId: node.run.id,
    parentRunId: node.run.parentId ?? null,
    definitionId: node.run.definitionId,
    state: node.run.state,
    outcome: node.run.outcome ?? null,
    requestedAt: node.run.requestedAt,
    ownership: node.run.ownership,
    compiled: node.run.compiled,
    resolvedModel: node.run.resolvedModel ?? null,
    activity: node.activity ?? null,
    sessionId: reference.sessionId,
    sessionFile: reference.sessionFile ?? null,
    persistedEntries: entries ?? null,
    persistedLoadError: loadError ?? null,
    liveTranscript: live ?? null,
  };
}

function flattenRunTree(root: RunTreeNode): readonly RunTreeNode[] {
  const nodes: RunTreeNode[] = [];
  const visit = (node: RunTreeNode): void => {
    nodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return nodes;
}

async function resolveDiagnosticArtifacts(
  diagnostics: WorkspaceRuntimeBinding["runtime"]["diagnostics"],
  rootRunId: RunId,
  entries: readonly DiagnosticLogEntry[],
): Promise<Readonly<Record<string, unknown>>> {
  const references = new Set<string>();
  collectArtifactReferences(entries, references);
  const artifacts: Record<string, unknown> = {};
  await Promise.all(
    [...references].map(async (reference) => {
      try {
        artifacts[reference] = await diagnostics.resolve(rootRunId, reference);
      } catch (error) {
        artifacts[reference] = { error: describeError(error) };
      }
    }),
  );
  return artifacts;
}

function collectArtifactReferences(value: unknown, references: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if ("ref" in value && typeof (value as { readonly ref?: unknown }).ref === "string") {
    const reference = (value as { readonly ref: string }).ref;
    if (reference.startsWith("artifact:sha256:")) references.add(reference);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactReferences(item, references);
    return;
  }
  for (const item of Object.values(value as Readonly<Record<string, unknown>>)) {
    collectArtifactReferences(item, references);
  }
}

async function readJsonl(file: string | undefined): Promise<readonly unknown[]> {
  if (!file) return [];
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          return {
            line: index + 1,
            parseError: describeError(error),
            raw: line,
          };
        }
      });
  } catch (error) {
    return [{ readError: describeError(error), file }];
  }
}

function manifestFile(
  cwd: string,
  binding: WorkspaceRuntimeBinding,
  requested: string | undefined,
): string {
  if (requested) return resolve(cwd, requested);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const diagnosticPath = binding.runtime.diagnostics.pathFor(binding.rootRunId);
  const directory = diagnosticPath
    ? join(dirname(diagnosticPath), "session-manifests")
    : resolve(cwd, ".phenix-agent-state", "session-manifests");
  return join(directory, `session-${safeName(binding.rootRunId)}-${timestamp}.json`);
}

function stringifyManifest(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, nested) => {
      if (typeof nested === "bigint") return String(nested);
      if (nested && typeof nested === "object") {
        if (seen.has(nested)) return "[circular]";
        seen.add(nested);
      }
      return nested;
    },
    2,
  );
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "root";
}

function stripMatchingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
