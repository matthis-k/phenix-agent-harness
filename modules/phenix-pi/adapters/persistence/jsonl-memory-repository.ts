import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import {
  assertValidMemoryNoteTransition,
  type MemoryLedgerEntry,
  parseMemoryLedgerEntry,
} from "../../domain/memory/codec.ts";
import type {
  EvidenceId,
  EvidenceRecord,
  MemoryHealthSnapshot,
  MemoryIntegrityIssue,
  MemoryMaintenanceResult,
  MemoryNote,
  MemoryNoteId,
  MemoryRepairResult,
} from "../../domain/memory/model.ts";
import type { MemoryPolicy } from "../../domain/memory/policy.ts";
import type { RunId } from "../../domain/shared.ts";
import type { MemoryRepository, PersistedMemoryState } from "../../ports/memory-repository.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;

type EvidenceIntegrityIssue = Extract<
  MemoryIntegrityIssue,
  {
    readonly kind: "evidence-missing" | "evidence-size-mismatch" | "evidence-hash-mismatch";
  }
>;

export class MemoryLedgerCorruptionError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(input: { readonly path: string; readonly line: number; readonly cause: unknown }) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(`Invalid Phenix memory ledger at ${input.path}:${input.line}: ${message}`);
    this.name = "MemoryLedgerCorruptionError";
    this.path = input.path;
    this.line = input.line;
  }
}

export class MemoryEvidenceIntegrityError extends Error {
  readonly issue: EvidenceIntegrityIssue;

  constructor(issue: EvidenceIntegrityIssue) {
    super(formatEvidenceIntegrityIssue(issue));
    this.name = "MemoryEvidenceIntegrityError";
    this.issue = issue;
  }
}

export class JsonlMemoryRepository implements MemoryRepository {
  private readonly stateDirectory: string;
  private readonly policy: MemoryPolicy;

  constructor(stateDirectory: string, policy: MemoryPolicy) {
    this.stateDirectory = stateDirectory;
    this.policy = policy;
  }

  async load(rootRunId: RunId): Promise<PersistedMemoryState> {
    const ledgerPath = this.ledgerPath(rootRunId);
    let content: string;
    try {
      content = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return emptyPersistedState();
      throw error;
    }

    const evidence = new Map<EvidenceId, EvidenceRecord>();
    const notes = new Map<MemoryNoteId, MemoryNote>();
    const issues: MemoryIntegrityIssue[] = [];
    const lines = content.split("\n");
    const unterminated = !content.endsWith("\n");

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const lineNumber = index + 1;
      let entry: MemoryLedgerEntry;
      try {
        entry = parseMemoryLedgerEntry(JSON.parse(line) as unknown);
      } catch (error) {
        if (unterminated && index === lines.length - 1) {
          issues.push({
            kind: "ledger-tail-truncated",
            line: lineNumber,
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        throw new MemoryLedgerCorruptionError({ path: ledgerPath, line: lineNumber, cause: error });
      }

      this.assertRoot(entry, rootRunId, lineNumber);
      switch (entry.type) {
        case "evidence.recorded": {
          const previous = evidence.get(entry.value.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(entry.value)) {
            throw new MemoryLedgerCorruptionError({
              path: ledgerPath,
              line: lineNumber,
              cause: new Error(`Evidence ${entry.value.id} was redefined`),
            });
          }
          evidence.set(entry.value.id, entry.value);
          break;
        }
        case "notes.recorded":
          for (const note of entry.value) {
            const previous = notes.get(note.id);
            if (previous) {
              try {
                assertValidMemoryNoteTransition(previous, note);
              } catch (error) {
                throw new MemoryLedgerCorruptionError({ path: ledgerPath, line: lineNumber, cause: error });
              }
            }
            notes.set(note.id, note);
          }
          break;
      }
    }

    return {
      evidence: [...evidence.values()],
      notes: [...notes.values()],
      issues,
      ledgerBytes: Buffer.byteLength(content, "utf8"),
    };
  }

  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > this.policy.storage.maximumEvidenceBytes) {
      throw new Error(
        `Evidence payload exceeds ${this.policy.storage.maximumEvidenceBytes} bytes: ${sizeBytes}`,
      );
    }
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (record.contentHash !== actualHash) {
      throw new Error(`Evidence content hash mismatch before persistence: ${record.id}`);
    }
    if (record.sizeBytes !== sizeBytes) {
      throw new Error(`Evidence size mismatch before persistence: ${record.id}`);
    }

    const evidenceDirectory = path.join(this.rootDirectory(record.rootRunId), "evidence");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const target = this.evidencePath(record.rootRunId, record.contentHash);
    const temporary = path.join(evidenceDirectory, `.${record.contentHash}.${randomUUID()}.tmp`);

    try {
      const existing = await this.readPayload(target);
      if (existing !== undefined) {
        this.verifyPayload(record, existing);
      } else {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(content, "utf8");
          if (this.policy.storage.synchronizeWrites) await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
          if (this.policy.storage.synchronizeWrites) await syncDirectory(evidenceDirectory);
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
          const concurrent = await this.readPayload(target);
          if (concurrent === undefined) throw error;
          this.verifyPayload(record, concurrent);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }

    await this.append(record.rootRunId, { type: "evidence.recorded", value: record });
  }

  async appendNotes(notes: readonly MemoryNote[]): Promise<void> {
    if (notes.length === 0) throw new Error("Cannot append an empty memory note batch");
    if (notes.length > 128) throw new Error("Memory note batch exceeds 128 entries");
    const rootRunId = notes[0]?.rootRunId;
    if (!rootRunId) throw new Error("Memory note batch has no root");
    const ids = new Set<MemoryNoteId>();
    for (const note of notes) {
      if (note.rootRunId !== rootRunId) throw new Error("Memory note batch spans multiple roots");
      if (ids.has(note.id)) throw new Error(`Duplicate memory note in batch: ${note.id}`);
      ids.add(note.id);
    }

    const persisted = await this.load(rootRunId);
    const current = new Map(persisted.notes.map((note) => [note.id, note]));
    for (const note of notes) {
      const previous = current.get(note.id);
      if (previous) assertValidMemoryNoteTransition(previous, note);
      current.set(note.id, note);
    }
    await this.append(rootRunId, { type: "notes.recorded", value: notes });
  }

  async readEvidence(record: EvidenceRecord): Promise<string | undefined> {
    const content = await this.readPayload(this.evidencePath(record.rootRunId, record.contentHash));
    if (content === undefined) return undefined;
    if (this.policy.storage.verifyEvidenceOnRead) this.verifyPayload(record, content);
    return content;
  }

  async hasEvidence(rootRunId: RunId, id: EvidenceId): Promise<boolean> {
    return (await this.load(rootRunId)).evidence.some((candidate) => candidate.id === id);
  }

  async latestNote(rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined> {
    return (await this.load(rootRunId)).notes.find((candidate) => candidate.id === id);
  }

  async inspect(rootRunId: RunId, verifyEvidence: boolean): Promise<MemoryHealthSnapshot> {
    let state: PersistedMemoryState;
    try {
      state = await this.load(rootRunId);
    } catch (error) {
      if (error instanceof MemoryLedgerCorruptionError) {
        return emptyHealth(rootRunId, "corrupt", {
          kind: "ledger-entry-corrupt",
          line: error.line,
          message: error.message,
        });
      }
      return emptyHealth(rootRunId, "unavailable", {
        kind: "repository-unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const issues = [...state.issues];
    let verifiedEvidenceCount = 0;
    if (verifyEvidence) {
      for (const record of state.evidence) {
        const content = await this.readPayload(this.evidencePath(rootRunId, record.contentHash));
        if (content === undefined) {
          issues.push({
            kind: "evidence-missing",
            evidenceId: record.id,
            contentHash: record.contentHash,
          });
          continue;
        }
        const issue = payloadIssue(record, content);
        if (issue) issues.push(issue);
        else verifiedEvidenceCount += 1;
      }
    }
    const stateValue = healthState(issues);
    return {
      rootRunId,
      state: stateValue,
      writable: stateValue === "healthy" || stateValue === "degraded",
      issues,
      evidenceCount: state.evidence.length,
      noteCount: state.notes.length,
      activeNoteCount: state.notes.filter((note) => note.status === "active").length,
      storedBytes: state.evidence.reduce((total, record) => total + record.sizeBytes, 0),
      ledgerBytes: state.ledgerBytes,
      verifiedEvidenceCount,
    };
  }

  async repair(rootRunId: RunId): Promise<MemoryRepairResult> {
    let state: PersistedMemoryState;
    try {
      state = await this.load(rootRunId);
    } catch (error) {
      if (error instanceof MemoryLedgerCorruptionError) {
        return {
          repaired: false,
          removedLedgerBytes: 0,
          remainingIssues: [
            { kind: "ledger-entry-corrupt", line: error.line, message: error.message },
          ],
        };
      }
      return {
        repaired: false,
        removedLedgerBytes: 0,
        remainingIssues: [
          {
            kind: "repository-unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    const tail = state.issues.find((issue) => issue.kind === "ledger-tail-truncated");
    if (!tail) {
      return { repaired: false, removedLedgerBytes: 0, remainingIssues: state.issues };
    }
    const ledgerPath = this.ledgerPath(rootRunId);
    const content = await readFile(ledgerPath, "utf8");
    const retained = content.split("\n").slice(0, tail.line - 1).join("\n");
    const normalized = retained ? `${retained}\n` : "";
    await this.replaceFile(ledgerPath, normalized);
    const repaired = await this.load(rootRunId);
    return {
      repaired: true,
      removedLedgerBytes:
        Buffer.byteLength(content, "utf8") - Buffer.byteLength(normalized, "utf8"),
      remainingIssues: repaired.issues,
    };
  }

  async maintain(rootRunId: RunId, now: string): Promise<MemoryMaintenanceResult> {
    const state = await this.load(rootRunId);
    if (state.issues.length > 0) {
      throw new Error("Memory maintenance requires a clean ledger; run repair first");
    }
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error(`Invalid memory maintenance timestamp: ${now}`);

    const retainedNotes = state.notes.filter((note) => {
      const days = this.policy.storage.retentionDays[note.retention];
      if (days === null) return true;
      return Date.parse(note.updatedAt) + days * DAY_MS > nowMs;
    });
    const allReferenced = new Set(state.notes.flatMap((note) => note.evidenceIds));
    const retainedReferences = new Set(retainedNotes.flatMap((note) => note.evidenceIds));
    const retainedEvidence = state.evidence.filter(
      (record) => retainedReferences.has(record.id) || !allReferenced.has(record.id),
    );
    const retainedEvidenceIds = new Set(retainedEvidence.map((record) => record.id));
    const removedEvidence = state.evidence.filter((record) => !retainedEvidenceIds.has(record.id));

    const entries: MemoryLedgerEntry[] = retainedEvidence.map((value) => ({
      type: "evidence.recorded" as const,
      value,
    }));
    for (let offset = 0; offset < retainedNotes.length; offset += 128) {
      entries.push({ type: "notes.recorded", value: retainedNotes.slice(offset, offset + 128) });
    }
    const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const ledger = serialized ? `${serialized}\n` : "";
    await this.replaceFile(this.ledgerPath(rootRunId), ledger);

    const retainedHashes = new Set(retainedEvidence.map((record) => record.contentHash));
    const removedHashes = new Set(
      removedEvidence
        .filter((record) => !retainedHashes.has(record.contentHash))
        .map((record) => record.contentHash),
    );
    for (const hash of removedHashes) {
      await rm(this.evidencePath(rootRunId, hash), { force: true });
    }
    if (this.policy.storage.synchronizeWrites && removedHashes.size > 0) {
      await syncDirectory(path.join(this.rootDirectory(rootRunId), "evidence"));
    }

    return {
      removedNoteCount: state.notes.length - retainedNotes.length,
      removedEvidenceCount: removedEvidence.length,
      reclaimedEvidenceBytes: removedEvidence.reduce((total, record) => total + record.sizeBytes, 0),
      ledgerBytesBefore: state.ledgerBytes,
      ledgerBytesAfter: Buffer.byteLength(ledger, "utf8"),
    };
  }

  private async append(rootRunId: RunId, entry: MemoryLedgerEntry): Promise<void> {
    const directory = this.rootDirectory(rootRunId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(this.ledgerPath(rootRunId), "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
      if (this.policy.storage.synchronizeWrites) await handle.sync();
    } finally {
      await handle.close();
    }
    if (this.policy.storage.synchronizeWrites) await syncDirectory(directory);
  }

  private async replaceFile(target: string, content: string): Promise<void> {
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      if (this.policy.storage.synchronizeWrites) await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      if (this.policy.storage.synchronizeWrites) await syncDirectory(directory);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async readPayload(target: string): Promise<string | undefined> {
    try {
      return await readFile(target, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private verifyPayload(record: EvidenceRecord, content: string): void {
    const issue = payloadIssue(record, content);
    if (issue) throw new MemoryEvidenceIntegrityError(issue);
  }

  private assertRoot(entry: MemoryLedgerEntry, rootRunId: RunId, line: number): void {
    const values = entry.type === "evidence.recorded" ? [entry.value] : entry.value;
    for (const value of values) {
      if (value.rootRunId !== rootRunId) {
        throw new MemoryLedgerCorruptionError({
          path: this.ledgerPath(rootRunId),
          line,
          cause: new Error(
            `memory entry root ${value.rootRunId} does not match ledger root ${rootRunId}`,
          ),
        });
      }
    }
  }

  private rootDirectory(rootRunId: RunId): string {
    const digest = createHash("sha256").update(rootRunId).digest("hex").slice(0, 16);
    return path.join(this.stateDirectory, "memory", `${digest}-${safePrefix(rootRunId)}`);
  }

  private ledgerPath(rootRunId: RunId): string {
    return path.join(this.rootDirectory(rootRunId), "memory.jsonl");
  }

  private evidencePath(rootRunId: RunId, contentHash: string): string {
    return path.join(this.rootDirectory(rootRunId), "evidence", `${contentHash}.txt`);
  }
}

function emptyPersistedState(): PersistedMemoryState {
  return { evidence: [], notes: [], issues: [], ledgerBytes: 0 };
}

function emptyHealth(
  rootRunId: RunId,
  state: "corrupt" | "unavailable",
  issue: MemoryIntegrityIssue,
): MemoryHealthSnapshot {
  return {
    rootRunId,
    state,
    writable: false,
    issues: [issue],
    evidenceCount: 0,
    noteCount: 0,
    activeNoteCount: 0,
    storedBytes: 0,
    ledgerBytes: 0,
    verifiedEvidenceCount: 0,
  };
}

function payloadIssue(record: EvidenceRecord, content: string): EvidenceIntegrityIssue | undefined {
  const actualBytes = Buffer.byteLength(content, "utf8");
  if (actualBytes !== record.sizeBytes) {
    return {
      kind: "evidence-size-mismatch",
      evidenceId: record.id,
      expectedBytes: record.sizeBytes,
      actualBytes,
    };
  }
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== record.contentHash) {
    return {
      kind: "evidence-hash-mismatch",
      evidenceId: record.id,
      expectedHash: record.contentHash,
      actualHash,
    };
  }
  return undefined;
}

function healthState(issues: readonly MemoryIntegrityIssue[]): MemoryHealthSnapshot["state"] {
  if (issues.some((issue) => issue.kind === "repository-unavailable")) return "unavailable";
  if (issues.some((issue) => issue.kind !== "ledger-tail-truncated")) return "corrupt";
  return issues.length > 0 ? "degraded" : "healthy";
}

function formatEvidenceIntegrityIssue(issue: EvidenceIntegrityIssue): string {
  switch (issue.kind) {
    case "evidence-missing":
      return `Evidence payload is missing: ${issue.evidenceId}`;
    case "evidence-size-mismatch":
      return `Evidence size mismatch for ${issue.evidenceId}: expected ${issue.expectedBytes}, got ${issue.actualBytes}`;
    case "evidence-hash-mismatch":
      return `Evidence hash mismatch for ${issue.evidenceId}: expected ${issue.expectedHash}, got ${issue.actualHash}`;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as { readonly code?: unknown }).code === code;
}

function safePrefix(value: string): string {
  const prefix = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
  return prefix || "root";
}
