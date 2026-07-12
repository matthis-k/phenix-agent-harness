import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  type ContractArtifact,
  type ContractId,
  type ContractResult,
  type PendingContractResult,
  type SubmittedContractResult,
  type CancelledContractResult,
} from "./contract.ts";
import {
  decodeContractArtifact,
} from "./contract-codec.ts";

// ── Errors ──────────────────────────────────────────────────────────────────

export class ContractStoreError extends Error {
  readonly code:
    | "not-found"
    | "already-terminal"
    | "revision-conflict"
    | "invalid-artifact"
    | "io-failure";

  constructor(
    code: ContractStoreError["code"],
    message: string,
    options?: {
      readonly cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = "ContractStoreError";
    this.code = code;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

interface PersistedContractDirectory {
  readonly artifact: ContractArtifact;
  readonly result: ContractResult;
}

// ── Atomic file writes ──────────────────────────────────────────────────────

function atomicWriteJson(
  target: string,
  value: unknown,
): void {
  fs.mkdirSync(path.dirname(target), {
    recursive: true,
    mode: 0o700,
  });

  const temporary =
    `${target}.${process.pid}.${randomUUID()}.tmp`;

  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );

    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.rmSync(temporary, {
        force: true,
      });
    } catch {
      // Preserve the original failure.
    }

    throw error;
  }
}

// ── Result decoding ─────────────────────────────────────────────────────────

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function decodeResult(
  value: unknown,
): ContractResult {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.contractId !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.state !== "string"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract result is malformed.",
    );
  }

  if (
    value.state !== "pending" &&
    value.state !== "submitted" &&
    value.state !== "cancelled"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      `Unknown contract result state: ${String(value.state)}`,
    );
  }

  return value as unknown as ContractResult;
}

// ── Store implementation ────────────────────────────────────────────────────

export class FileContractStore {
  readonly root: string;

  private readonly locks =
    new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  private contractDirectory(
    id: ContractId,
  ): string {
    return path.join(this.root, id);
  }

  private artifactPath(
    id: ContractId,
  ): string {
    return path.join(
      this.contractDirectory(id),
      "contract.json",
    );
  }

  private resultPath(
    id: ContractId,
  ): string {
    return path.join(
      this.contractDirectory(id),
      "result.json",
    );
  }

  private async exclusive<T>(
    id: ContractId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();

    let resolve: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });

    this.locks.set(
      id,
      next.finally(() => {
        if (this.locks.get(id) === next) {
          this.locks.delete(id);
        }
      }),
    );

    try {
      await previous;
      return await operation();
    } finally {
      resolve!();
    }
  }

  // ── CRUD operations ────────────────────────────────────────────────

  async create(
    artifact: ContractArtifact,
  ): Promise<PendingContractResult> {
    return this.exclusive(artifact.id, async () => {
      // Verify the contract directory does not already exist.
      const dir = this.contractDirectory(artifact.id);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory()) {
          throw new ContractStoreError(
            "revision-conflict",
            `Contract ${artifact.id} already exists.`,
          );
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !==
          "ENOENT"
        ) {
          throw error;
        }
      }

      // Persist the artifact.
      atomicWriteJson(
        this.artifactPath(artifact.id),
        artifact,
      );

      // Create the initial pending result.
      const pending: PendingContractResult = {
        schemaVersion: 1,
        state: "pending",
        contractId: artifact.id,
        revision: 0,
        createdAt: new Date().toISOString(),
      };

      atomicWriteJson(
        this.resultPath(artifact.id),
        pending,
      );

      return pending;
    });
  }

  async load(
    id: ContractId,
  ): Promise<PersistedContractDirectory | undefined> {
    try {
      const artifactRaw = JSON.parse(
        fs.readFileSync(this.artifactPath(id), "utf-8"),
      );

      // Use the integrated codec for deep validation.
      const artifact = decodeContractArtifact(artifactRaw);

      const resultRaw = JSON.parse(
        fs.readFileSync(this.resultPath(id), "utf-8"),
      );

      const result = decodeResult(resultRaw);

      return { artifact, result };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return undefined;
      }

      if (error instanceof ContractStoreError) {
        throw error;
      }

      throw new ContractStoreError(
        "io-failure",
        `Failed to load contract ${id}.`,
        {
          cause: error,
        },
      );
    }
  }

  async submit(
    id: ContractId,
    expectedRevision: number,
    value: unknown,
  ): Promise<SubmittedContractResult> {
    return this.exclusive(id, async () => {
      const current = await this.load(id);

      if (!current) {
        throw new ContractStoreError(
          "not-found",
          `Contract ${id} does not exist.`,
        );
      }

      if (current.result.state !== "pending") {
        throw new ContractStoreError(
          "already-terminal",
          `Contract ${id} is already ${current.result.state}.`,
        );
      }

      if (
        current.result.revision !==
        expectedRevision
      ) {
        throw new ContractStoreError(
          "revision-conflict",
          `Contract ${id} revision mismatch.`,
        );
      }

      const submitted: SubmittedContractResult = {
        schemaVersion: 1,
        state: "submitted",
        contractId: id,
        revision:
          current.result.revision + 1,
        submittedAt:
          new Date().toISOString(),
        value,
      };

      atomicWriteJson(
        this.resultPath(id),
        submitted,
      );

      return submitted;
    });
  }

  async cancel(
    id: ContractId,
    reason: string,
  ): Promise<CancelledContractResult> {
    return this.exclusive(
      id,
      async () => {
        const current = await this.load(id);

        if (!current) {
          throw new ContractStoreError(
            "not-found",
            `Contract ${id} does not exist.`,
          );
        }

        if (current.result.state !== "pending") {
          throw new ContractStoreError(
            "already-terminal",
            `Contract ${id} is already ${current.result.state}.`,
          );
        }

        const cancelled: CancelledContractResult = {
          schemaVersion: 1,
          state: "cancelled",
          contractId: id,
          revision:
            current.result.revision + 1,
          cancelledAt:
            new Date().toISOString(),
          reason,
        };

        atomicWriteJson(
          this.resultPath(id),
          cancelled,
        );

        return cancelled;
      },
    );
  }
}
