/**
 * phenix-persistence — shared JSON file mechanics
 *
 * Domain stores own schemas, state transitions, revisions, and locking. This
 * module owns only deterministic filesystem mechanics so atomic-write and
 * error-handling behavior cannot drift between stores.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Convert an external identifier into one safe path segment. */
export function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Return an ISO-8601 timestamp from the process clock. */
export function timestamp(): string {
  return new Date().toISOString();
}

/** Narrow an unknown filesystem error by its Node errno code. */
export function isErrno(
  error: unknown,
  code: NodeJS.ErrnoException["code"],
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

/** Find the nearest Git repository root, falling back to the supplied cwd. */
export function findRepositoryRoot(cwd: string): string {
  const fallback = path.resolve(cwd);
  let current = fallback;

  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

/**
 * Write JSON through a same-directory temporary file and fsync both file and
 * containing directory before returning.
 */
export function atomicWriteJson(target: string, value: unknown): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    fs.renameSync(temporary, target);

    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write failure.
    }
  }
}

/**
 * Read and decode one JSON file. Missing files return undefined; malformed data
 * and codec failures are surfaced to the domain store.
 */
export function readJsonFile<T>(target: string, decode: (value: unknown) => T): T | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(target, "utf-8"));
    return decode(value);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Read a directory, treating a missing directory as an empty collection. */
export function readDirectory(target: string): readonly string[] {
  try {
    return fs.readdirSync(target);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
}
