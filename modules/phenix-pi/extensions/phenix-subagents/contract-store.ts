import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, isErrno, readJsonFile } from "../phenix-persistence/json-files.ts";
import type {
  AcceptedContractResult,
  CancelledContractResult,
  ContractArtifact,
  ContractId,
  ContractResult,
  ContractSubmissionRecord,
  PendingContractResult,
  SubmittedContractResult,
} from "./contract.ts";
import { decodeContractArtifact } from "./contract-codec.ts";

// ── Errors ──────────────────────────────────────────────────────────────────

export class ContractStoreError extends Error {
  readonly code:
    | "not-found"
    | "already-terminal"
    | "revision-conflict"
    | "invalid-artifact"
    | "io-failure"
    | "invalid-state-transition";

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

// ── Result decoding ─────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeResult(value: unknown): ContractResult {
  if (
    !isObject(value) ||
    typeof value.contractId !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.state !== "string"
  ) {
    throw new ContractStoreError("invalid-artifact", "Contract result is malformed.");
  }

  if (
    value.state !== "pending" &&
    value.state !== "submitted" &&
    value.state !== "accepted" &&
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

  private readonly locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  private contractDirectory(id: ContractId): string {
    return path.join(this.root, id);
  }

  private artifactPath(id: ContractId): string {
    return path.join(this.contractDirectory(id), "contract.json");
  }

  private resultPath(id: ContractId): string {
    return path.join(this.contractDirectory(id), "result.json");
  }

  private async exclusive<T>(id: ContractId, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();

    let resolve: (() => void) | undefined;
    const next = new Promise<void>((r) => {
      resolve = r;
    });

    const queued = next.finally(() => {
      if (this.locks.get(id) === queued) {
        this.locks.delete(id);
      }
    });
    this.locks.set(id, queued);

    try {
      await previous;
      return await operation();
    } finally {
      resolve?.();
    }
  }

  // ── CRUD operations ────────────────────────────────────────────────

  async create(artifact: ContractArtifact): Promise<PendingContractResult> {
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
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      }

      // Persist the artifact.
      atomicWriteJson(this.artifactPath(artifact.id), artifact);

      // Create the initial pending result.
      const pending: PendingContractResult = {
        schemaVersion: 2,
        state: "pending",
        contractId: artifact.id,
        revision: 0,
        createdAt: new Date().toISOString(),
        history: [],
      };

      atomicWriteJson(this.resultPath(artifact.id), pending);

      return pending;
    });
  }

  async load(id: ContractId): Promise<PersistedContractDirectory | undefined> {
    try {
      const artifact = readJsonFile(this.artifactPath(id), decodeContractArtifact);
      const result = readJsonFile(this.resultPath(id), decodeResult);

      if (!artifact || !result) return undefined;
      return { artifact, result };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;

      if (error instanceof ContractStoreError) {
        throw error;
      }

      throw new ContractStoreError("io-failure", `Failed to load contract ${id}.`, {
        cause: error,
      });
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
        throw new ContractStoreError("not-found", `Contract ${id} does not exist.`);
      }

      if (current.result.state !== "pending") {
        throw new ContractStoreError(
          "already-terminal",
          `Contract ${id} is already ${current.result.state}.`,
        );
      }

      if (current.result.revision !== expectedRevision) {
        throw new ContractStoreError("revision-conflict", `Contract ${id} revision mismatch.`);
      }

      const submissionRecord: ContractSubmissionRecord = {
        revision: current.result.revision + 1,
        submittedAt: new Date().toISOString(),
        value,
      };

      const submitted: SubmittedContractResult = {
        schemaVersion: 2,
        state: "submitted",
        contractId: id,
        revision: current.result.revision + 1,
        submittedAt: submissionRecord.submittedAt,
        value,
        history: [...current.result.history, submissionRecord],
      };

      atomicWriteJson(this.resultPath(id), submitted);

      return submitted;
    });
  }

  async cancel(id: ContractId, reason: string): Promise<CancelledContractResult> {
    return this.exclusive(id, async () => {
      const current = await this.load(id);

      if (!current) {
        throw new ContractStoreError("not-found", `Contract ${id} does not exist.`);
      }

      if (current.result.state !== "pending" && current.result.state !== "submitted") {
        throw new ContractStoreError(
          "already-terminal",
          `Contract ${id} is already ${current.result.state}.`,
        );
      }

      const cancelled: CancelledContractResult = {
        schemaVersion: 2,
        state: "cancelled",
        contractId: id,
        revision: current.result.revision + 1,
        cancelledAt: new Date().toISOString(),
        reason,
        history: current.result.history,
      };

      atomicWriteJson(this.resultPath(id), cancelled);

      return cancelled;
    });
  }

  // ── Reopen: submitted → pending (with rejection history) ─────────────

  async reopen(
    id: ContractId,
    expectedRevision: number,
    disposition: ContractSubmissionRecord["disposition"],
    issues: readonly {
      readonly path: readonly (string | number)[];
      readonly message: string;
      readonly code?: string;
    }[],
  ): Promise<PendingContractResult> {
    return this.exclusive(id, async () => {
      const current = await this.load(id);

      if (!current) {
        throw new ContractStoreError("not-found", `Contract ${id} does not exist.`);
      }

      if (current.result.state !== "submitted") {
        throw new ContractStoreError(
          "invalid-state-transition",
          `Cannot reopen contract ${id} from state ${current.result.state}.`,
        );
      }

      if (current.result.revision !== expectedRevision) {
        throw new ContractStoreError("revision-conflict", `Contract ${id} revision mismatch.`);
      }

      // Update the last submission record with rejection disposition.
      const history = [...current.result.history];
      const lastRecord = history[history.length - 1];
      if (lastRecord) {
        history[history.length - 1] = {
          ...lastRecord,
          disposition,
          issues,
        };
      }

      const pending: PendingContractResult = {
        schemaVersion: 2,
        state: "pending",
        contractId: id,
        revision: current.result.revision + 1,
        createdAt: new Date().toISOString(),
        history,
      };

      atomicWriteJson(this.resultPath(id), pending);

      return pending;
    });
  }

  // ── Accept: submitted → accepted ─────────────────────────────────────

  async accept(id: ContractId, expectedRevision: number): Promise<AcceptedContractResult> {
    return this.exclusive(id, async () => {
      const current = await this.load(id);

      if (!current) {
        throw new ContractStoreError("not-found", `Contract ${id} does not exist.`);
      }

      if (current.result.state !== "submitted") {
        throw new ContractStoreError(
          "invalid-state-transition",
          `Cannot accept contract ${id} from state ${current.result.state}.`,
        );
      }

      if (current.result.revision !== expectedRevision) {
        throw new ContractStoreError("revision-conflict", `Contract ${id} revision mismatch.`);
      }

      // Mark the last submission record as accepted.
      const history = [...current.result.history];
      const lastRecord = history[history.length - 1];
      if (lastRecord) {
        history[history.length - 1] = {
          ...lastRecord,
          disposition: "accepted",
        };
      }

      const accepted: AcceptedContractResult = {
        schemaVersion: 2,
        state: "accepted",
        contractId: id,
        revision: current.result.revision + 1,
        acceptedAt: new Date().toISOString(),
        value: current.result.value,
        history,
      };

      atomicWriteJson(this.resultPath(id), accepted);

      return accepted;
    });
  }
}
