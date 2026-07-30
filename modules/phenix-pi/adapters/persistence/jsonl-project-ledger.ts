import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  projectId,
  type ProjectEvent,
  type ProjectId,
  type UnsequencedProjectEvent,
} from "../../domain/project/model.ts";
import {
  ProjectLedgerConflictError,
  type ProjectLedger,
} from "../../ports/project-ledger.ts";

const LOCK_RETRIES = 200;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 60_000;

export class JsonlProjectLedger implements ProjectLedger {
  private readonly stateDirectory: string;

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
  }

  async list(): Promise<readonly ProjectId[]> {
    const directory = this.projectsDirectory();
    let entries: readonly { readonly name: string; readonly isDirectory: () => boolean }[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => projectId(entry.name))
      .sort();
  }

  async load(id: ProjectId): Promise<readonly ProjectEvent[]> {
    return this.readEvents(id);
  }

  async append(
    id: ProjectId,
    expectedRevision: number,
    events: readonly UnsequencedProjectEvent[],
  ): Promise<readonly ProjectEvent[]> {
    if (events.some((event) => event.projectId !== id)) {
      throw new Error("Cannot append an event to a different project ledger");
    }
    if (events.length === 0) return [];

    const directory = this.projectDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await this.acquireLock(id);
    try {
      const current = await this.readEvents(id);
      if (current.length !== expectedRevision) {
        throw new ProjectLedgerConflictError(expectedRevision, current.length);
      }
      const committed = events.map((event, index) => ({
        ...event,
        revision: expectedRevision + index + 1,
      }));
      const handle = await open(this.eventsFile(id), "a", 0o600);
      try {
        await handle.write(`${committed.map((event) => JSON.stringify(event)).join("\n")}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return committed;
    } finally {
      await release();
    }
  }

  private async acquireLock(id: ProjectId): Promise<() => Promise<void>> {
    const lock = this.lockFile(id);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        const handle = await open(lock, "wx", 0o600);
        await handle.write(`${process.pid}\n${Date.now()}\n`);
        await handle.sync();
        return async () => {
          await handle.close();
          await rm(lock, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.removeStaleLock(lock);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    throw new Error(`Timed out acquiring project ledger lock for ${id}`);
  }

  private async removeStaleLock(lock: string): Promise<void> {
    try {
      const metadata = await stat(lock);
      if (Date.now() - metadata.mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readEvents(id: ProjectId): Promise<readonly ProjectEvent[]> {
    let content: string;
    try {
      content = await readFile(this.eventsFile(id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!content.trim()) return [];
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line) as ProjectEvent;
        } catch (error) {
          throw new Error(
            `Invalid project ledger JSON at ${this.eventsFile(id)}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }

  private projectsDirectory(): string {
    return path.join(this.stateDirectory, "projects");
  }

  private projectDirectory(id: ProjectId): string {
    return path.join(this.projectsDirectory(), id);
  }

  private eventsFile(id: ProjectId): string {
    return path.join(this.projectDirectory(id), "events.jsonl");
  }

  private lockFile(id: ProjectId): string {
    return path.join(this.projectDirectory(id), ".write.lock");
  }
}
