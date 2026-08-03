import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { parsePersistedDomainEvent } from "../../domain/run/event-codec.ts";
import type { DomainEvent, UnsequencedDomainEvent } from "../../domain/run/events.ts";
import type { RunId } from "../../domain/shared.ts";
import { LedgerConflictError, type RunLedger } from "../../ports/run-ledger.ts";

/**
 * A root ledger has one runtime writer. ExecutionStore serializes commits per root;
 * this adapter caches the last durable sequence so append does not reparse history.
 * A new adapter instance initializes that cache from disk on its first load or append.
 */
export class JsonlRunLedger implements RunLedger {
  private readonly stateDirectory: string;
  private readonly sequences = new Map<RunId, number>();

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
  }

  async load(rootRunId: RunId): Promise<readonly DomainEvent[]> {
    const events = await this.readEvents(rootRunId);
    this.sequences.set(rootRunId, events.length);
    return events;
  }

  async append(
    rootRunId: RunId,
    expectedSequence: number,
    events: readonly UnsequencedDomainEvent[],
  ): Promise<readonly DomainEvent[]> {
    const currentSequence = await this.currentSequence(rootRunId);
    if (currentSequence !== expectedSequence) {
      throw new LedgerConflictError(expectedSequence, currentSequence);
    }
    if (events.some((event) => event.rootRunId !== rootRunId)) {
      throw new Error(`Cannot append an event to a different root ledger`);
    }
    const committed = events.map((event, index) => ({
      ...event,
      sequence: expectedSequence + index + 1,
    }));
    if (committed.length === 0) return committed;

    const file = this.file(rootRunId);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, "a", 0o600);
    try {
      await handle.write(`${committed.map((event) => JSON.stringify(event)).join("\n")}\n`);
      await handle.sync();
      this.sequences.set(rootRunId, expectedSequence + committed.length);
    } finally {
      await handle.close();
    }
    return committed;
  }

  pathFor(rootRunId: RunId): string {
    return this.file(rootRunId);
  }

  private async currentSequence(rootRunId: RunId): Promise<number> {
    const cached = this.sequences.get(rootRunId);
    if (cached !== undefined) return cached;
    return (await this.load(rootRunId)).length;
  }

  private async readEvents(rootRunId: RunId): Promise<readonly DomainEvent[]> {
    const file = this.file(rootRunId);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (content.trim().length === 0) return [];
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        try {
          const decoded: unknown = JSON.parse(line);
          const event = parsePersistedDomainEvent(decoded);
          if (event.rootRunId !== rootRunId) {
            throw new Error(`event belongs to root ${event.rootRunId}`);
          }
          return event;
        } catch (error) {
          throw new Error(
            `Invalid Phenix ledger event at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }

  private file(rootRunId: RunId): string {
    const digest = createHash("sha256").update(rootRunId).digest("hex").slice(0, 16);
    return path.join(
      this.stateDirectory,
      "runs",
      `${digest}-${safePrefix(rootRunId)}`,
      "events.jsonl",
    );
  }
}

function safePrefix(value: string): string {
  const prefix = value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32);
  return prefix || "root";
}
