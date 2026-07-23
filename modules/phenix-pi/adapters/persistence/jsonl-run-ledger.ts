import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import type { DomainEvent, UnsequencedDomainEvent } from "../../domain/run/events.ts";
import type { RunId } from "../../domain/shared.ts";
import { LedgerConflictError, type RunLedger } from "../../ports/run-ledger.ts";

export class JsonlRunLedger implements RunLedger {
  private readonly stateDirectory: string;

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
  }

  async load(rootRunId: RunId): Promise<readonly DomainEvent[]> {
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
          return JSON.parse(line) as DomainEvent;
        } catch (error) {
          throw new Error(
            `Invalid Phenix ledger JSON at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }

  async append(
    rootRunId: RunId,
    expectedSequence: number,
    events: readonly UnsequencedDomainEvent[],
  ): Promise<readonly DomainEvent[]> {
    const current = await this.load(rootRunId);
    if (current.length !== expectedSequence) {
      throw new LedgerConflictError(expectedSequence, current.length);
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
    } finally {
      await handle.close();
    }
    return committed;
  }

  pathFor(rootRunId: RunId): string {
    return this.file(rootRunId);
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
