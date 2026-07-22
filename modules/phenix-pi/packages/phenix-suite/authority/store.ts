import fs from "node:fs";
import path from "node:path";

import type { ExecutionAuthorityPersistence } from "./types.ts";

export interface ExecutionAuthorityStore {
  load(): ExecutionAuthorityPersistence;
  save(snapshot: ExecutionAuthorityPersistence): void;
}

export function emptyAuthorityPersistence(): ExecutionAuthorityPersistence {
  return {
    sequence: 0,
    objectives: [],
    nodes: [],
    handles: [],
    legalActionsByObjective: {},
    events: [],
    idempotency: {},
  };
}

function clone(snapshot: ExecutionAuthorityPersistence): ExecutionAuthorityPersistence {
  return structuredClone(snapshot);
}

export class InMemoryExecutionAuthorityStore implements ExecutionAuthorityStore {
  private snapshot: ExecutionAuthorityPersistence;

  constructor(initial: ExecutionAuthorityPersistence = emptyAuthorityPersistence()) {
    this.snapshot = clone(initial);
  }

  load(): ExecutionAuthorityPersistence {
    return clone(this.snapshot);
  }

  save(snapshot: ExecutionAuthorityPersistence): void {
    this.snapshot = clone(snapshot);
  }
}

export class FileExecutionAuthorityStore implements ExecutionAuthorityStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  load(): ExecutionAuthorityPersistence {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as ExecutionAuthorityPersistence;
      return clone(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAuthorityPersistence();
      throw error;
    }
  }

  save(snapshot: ExecutionAuthorityPersistence): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
  }
}
