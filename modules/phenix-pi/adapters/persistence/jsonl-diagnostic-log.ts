import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertDiagnosticScope,
  type DiagnosticArtifactReference,
  type DiagnosticLogEntry,
  type DiagnosticSeverity,
  type DiagnosticSummary,
  type DiagnosticWrite,
  includesSeverity,
} from "../../domain/diagnostics.ts";
import type { RunId } from "../../domain/shared.ts";
import type { DiagnosticLog, DiagnosticLogListener } from "../../ports/diagnostic-log.ts";

const INLINE_STRING_BYTES = 256;
const INLINE_VALUE_BYTES = 1_024;
const MAX_INLINE_DEPTH = 5;
const SECRET_KEY =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie/i;

export class JsonlDiagnosticLog implements DiagnosticLog {
  private readonly stateDirectory: string;
  private readonly listeners = new Set<DiagnosticLogListener>();
  private tail: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
  }

  async record(input: DiagnosticWrite): Promise<DiagnosticLogEntry> {
    assertDiagnosticScope(input.scope);
    let committed: DiagnosticLogEntry | undefined;
    const pending = this.tail.then(async () => {
      const fields = input.fields
        ? await this.materializeFields(input.rootRunId, input.fields)
        : undefined;
      committed = {
        version: 1,
        timestamp: input.timestamp ?? new Date().toISOString(),
        severity: input.severity,
        scope: input.scope,
        message: normalizeMessage(input.message),
        rootRunId: input.rootRunId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
      };
      const file = this.pathFor(input.rootRunId);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const handle = await open(file, "a", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.write(`${JSON.stringify(committed)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.tail = pending.catch(() => undefined);
    await pending;
    if (!committed) throw new Error("Diagnostic entry was not committed");
    this.notify(committed);
    return committed;
  }

  async entries(
    rootRunId: RunId,
    minimum: DiagnosticSeverity = "trace",
    limit?: number,
  ): Promise<readonly DiagnosticLogEntry[]> {
    await this.drain();
    let content: string;
    try {
      content = await readFile(this.pathFor(rootRunId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as DiagnosticLogEntry;
        } catch (error) {
          throw new Error(
            `Invalid Phenix diagnostic JSON at ${this.pathFor(rootRunId)}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .filter((entry) => includesSeverity(entry.severity, minimum));
    if (limit === undefined || !Number.isFinite(limit)) return entries;
    const bounded = Math.max(0, Math.floor(limit));
    return bounded === 0 ? [] : entries.slice(-bounded);
  }

  async export(rootRunId: RunId, minimum: DiagnosticSeverity = "trace"): Promise<string> {
    const entries = await this.entries(rootRunId, minimum);
    return entries.length === 0
      ? ""
      : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  }

  async resolve(rootRunId: RunId, reference: string): Promise<string> {
    await this.drain();
    const match = /^artifact:sha256:([a-f0-9]{64})$/.exec(reference.trim());
    if (!match) throw new Error(`Invalid artifact reference: ${reference}`);
    const digest = match[1];
    const directory = path.join(this.artifactDirectoryFor(rootRunId), digest.slice(0, 2));
    for (const extension of ["json", "txt"] as const) {
      try {
        return await readFile(path.join(directory, `${digest}.${extension}`), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Diagnostic artifact is missing: ${reference}`);
  }

  async summary(rootRunId: RunId): Promise<DiagnosticSummary> {
    const entries = await this.entries(rootRunId, "trace");
    const counts: Record<DiagnosticSeverity, number> = {
      trace: 0,
      info: 0,
      warning: 0,
      error: 0,
    };
    const artifacts = new Set<string>();
    for (const entry of entries) {
      counts[entry.severity] += 1;
      collectReferences(entry.fields, artifacts);
    }
    const latest = entries.at(-1);
    return {
      total: entries.length,
      artifacts: artifacts.size,
      counts,
      ...(latest ? { latest } : {}),
    };
  }

  pathFor(rootRunId: RunId): string {
    return path.join(this.rootDirectory(rootRunId), "logs.jsonl");
  }

  artifactDirectoryFor(rootRunId: RunId): string {
    return path.join(this.rootDirectory(rootRunId), "artifacts", "sha256");
  }

  subscribe(listener: DiagnosticLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  private notify(entry: DiagnosticLogEntry): void {
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(entry)).catch(() => undefined);
      } catch {
        // Diagnostic observers must not affect runtime execution.
      }
    }
  }

  private async materializeFields(
    rootRunId: RunId,
    fields: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      output[key] = SECRET_KEY.test(key)
        ? "[redacted]"
        : await this.materializeValue(rootRunId, value, key, 0);
    }
    return output;
  }

  private async materializeValue(
    rootRunId: RunId,
    value: unknown,
    key: string,
    depth: number,
  ): Promise<unknown> {
    if (
      value === null ||
      value === undefined ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      return value ?? null;
    }
    if (typeof value === "bigint") return String(value);
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf8");
      return bytes <= INLINE_STRING_BYTES && !value.includes("\n")
        ? value
        : this.storeArtifact(rootRunId, value, "text/plain");
    }
    if (value instanceof Error) {
      return this.materializeValue(
        rootRunId,
        { name: value.name, message: value.message, stack: value.stack },
        key,
        depth,
      );
    }
    if (depth >= MAX_INLINE_DEPTH) {
      return this.storeArtifact(rootRunId, safelySerializable(value), "application/json");
    }
    if (Array.isArray(value)) {
      const materialized = await Promise.all(
        value.map((item, index) =>
          this.materializeValue(rootRunId, item, `${key}.${index}`, depth + 1),
        ),
      );
      return encodedBytes(materialized) <= INLINE_VALUE_BYTES
        ? materialized
        : this.storeArtifact(rootRunId, materialized, "application/json");
    }
    if (typeof value === "object") {
      const materialized: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        materialized[nestedKey] = SECRET_KEY.test(nestedKey)
          ? "[redacted]"
          : await this.materializeValue(
              rootRunId,
              nestedValue,
              `${key}.${nestedKey}`,
              depth + 1,
            );
      }
      return encodedBytes(materialized) <= INLINE_VALUE_BYTES
        ? materialized
        : this.storeArtifact(rootRunId, materialized, "application/json");
    }
    return String(value);
  }

  private async storeArtifact(
    rootRunId: RunId,
    value: unknown,
    contentType: DiagnosticArtifactReference["contentType"],
  ): Promise<DiagnosticArtifactReference> {
    const text =
      contentType === "text/plain"
        ? String(value)
        : JSON.stringify(safelySerializable(value), null, 2);
    const digest = createHash("sha256").update(text).digest("hex");
    const bytes = Buffer.byteLength(text, "utf8");
    const extension = contentType === "text/plain" ? "txt" : "json";
    const directory = path.join(this.artifactDirectoryFor(rootRunId), digest.slice(0, 2));
    const file = path.join(directory, `${digest}.${extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(file, "a+", 0o600);
    try {
      await handle.chmod(0o600);
      const current = await handle.stat();
      if (current.size === 0) {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
    return { ref: `artifact:sha256:${digest}`, digest, bytes, contentType };
  }

  private rootDirectory(rootRunId: RunId): string {
    const digest = createHash("sha256").update(rootRunId).digest("hex").slice(0, 16);
    return path.join(this.stateDirectory, "runs", `${digest}-${safePrefix(rootRunId)}`);
  }
}

function normalizeMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 512);
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(safelySerializable(value)), "utf8");
}

function safelySerializable(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return String(nested);
      if (nested instanceof Error) {
        return { name: nested.name, message: nested.message, stack: nested.stack };
      }
      if (nested && typeof nested === "object") {
        if (seen.has(nested)) return "[circular]";
        seen.add(nested);
      }
      return nested;
    }) ?? "null",
  );
}

function collectReferences(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if ("ref" in value && typeof (value as { ref?: unknown }).ref === "string") {
    const reference = (value as { ref: string }).ref;
    if (reference.startsWith("artifact:sha256:")) output.add(reference);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectReferences(item, output);
  }
}

function safePrefix(value: string): string {
  const prefix = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
  return prefix || "root";
}
