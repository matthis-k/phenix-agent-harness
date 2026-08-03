import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  EvidenceId,
  EvidenceRecord,
  MemoryNote,
  MemoryNoteId,
} from "../../domain/memory/model.ts";
import type { RunId } from "../../domain/shared.ts";
import type { MemoryRepository, PersistedMemoryState } from "../../ports/memory-repository.ts";

type MemoryLedgerEntry =
  | { readonly type: "evidence.recorded"; readonly value: EvidenceRecord }
  | { readonly type: "note.recorded"; readonly value: MemoryNote };

export class JsonlMemoryRepository implements MemoryRepository {
  private readonly stateDirectory: string;

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
  }

  async load(rootRunId: RunId): Promise<PersistedMemoryState> {
    const evidence = new Map<EvidenceId, EvidenceRecord>();
    const notes = new Map<MemoryNoteId, MemoryNote>();
    let content: string;
    try {
      content = await readFile(this.ledgerPath(rootRunId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { evidence: [], notes: [] };
      throw error;
    }
    for (const [index, line] of content.split("\n").entries()) {
      if (!line.trim()) continue;
      let entry: MemoryLedgerEntry;
      try {
        entry = JSON.parse(line) as MemoryLedgerEntry;
      } catch (error) {
        throw new Error(
          `Invalid Phenix memory JSON at ${this.ledgerPath(rootRunId)}:${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (entry.type === "evidence.recorded") evidence.set(entry.value.id, entry.value);
      if (entry.type === "note.recorded") notes.set(entry.value.id, entry.value);
    }
    return { evidence: [...evidence.values()], notes: [...notes.values()] };
  }

  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    const directory = this.rootDirectory(record.rootRunId);
    await mkdir(path.join(directory, "evidence"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.evidencePath(record.rootRunId, record.contentHash), content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await this.append(record.rootRunId, { type: "evidence.recorded", value: record });
  }

  async appendNote(note: MemoryNote): Promise<void> {
    await this.append(note.rootRunId, { type: "note.recorded", value: note });
  }

  async readEvidence(rootRunId: RunId, id: EvidenceId): Promise<string | undefined> {
    const record = (await this.load(rootRunId)).evidence.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    try {
      return await readFile(this.evidencePath(rootRunId, record.contentHash), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async hasEvidence(rootRunId: RunId, id: EvidenceId): Promise<boolean> {
    return (await this.load(rootRunId)).evidence.some((candidate) => candidate.id === id);
  }

  async latestNote(rootRunId: RunId, id: MemoryNoteId): Promise<MemoryNote | undefined> {
    return (await this.load(rootRunId)).notes.find((candidate) => candidate.id === id);
  }

  private async append(rootRunId: RunId, entry: MemoryLedgerEntry): Promise<void> {
    const directory = this.rootDirectory(rootRunId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(this.ledgerPath(rootRunId), `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
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

function safePrefix(value: string): string {
  const prefix = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
  return prefix || "root";
}
