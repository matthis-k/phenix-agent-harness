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

interface PersistedContractDirectory {
  readonly artifact: ContractArtifact;
  readonly result: ContractResult;
}

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

function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function decodeArtifact(
  value: unknown,
): ContractArtifact {
  if (
    !isObject(value) ||
    typeof value.version !== "number"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: missing or invalid version.",
    );
  }

  if (value.version === 1) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Unsupported contract version 1. This version of the Phenix runtime only supports contract version 2.",
    );
  }

  if (value.version !== 2) {
    throw new ContractStoreError(
      "invalid-artifact",
      `Unsupported contract version ${String(value.version)}.`,
    );
  }

  // Validate identity section.
  if (
    typeof value.id !== "string" ||
    !isObject(value.identity) ||
    typeof value.identity.runId !== "string" ||
    typeof value.identity.handleId !== "string"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid identity section.",
    );
  }

  // Validate assignment section.
  if (
    !isObject(value.assignment) ||
    typeof value.assignment.task !== "string" ||
    !Array.isArray(value.assignment.requirements) ||
    !isObject(value.assignment.outputSchema)
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid assignment section.",
    );
  }

  // Validate runtime section.
  if (
    !isObject(value.runtime) ||
    typeof value.runtime.agent !== "string" ||
    typeof value.runtime.cwd !== "string" ||
    typeof value.runtime.thinking !== "string" ||
    typeof value.runtime.timeoutMs !== "number" ||
    !Array.isArray(value.runtime.skills) ||
    !Array.isArray(value.runtime.extensions) ||
    !Array.isArray(value.runtime.allowedChildren) ||
    typeof value.runtime.maxDelegationDepth !== "number"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid runtime section.",
    );
  }

  // Validate tools section.
  if (
    !isObject(value.runtime.tools) ||
    typeof value.runtime.tools.presetRevision !== "number" ||
    !Array.isArray(value.runtime.tools.effective) ||
    !isObject(value.runtime.tools.source) ||
    !isObject(value.runtime.tools.source.patch) ||
    !Array.isArray(value.runtime.tools.source.patch.additional) ||
    !Array.isArray(value.runtime.tools.source.patch.removed)
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid tools section.",
    );
  }

  // Validate turn and tool budgets.
  if (
    !isObject(value.runtime.turnBudget) ||
    typeof value.runtime.turnBudget.maxTurns !== "number" ||
    typeof value.runtime.turnBudget.graceTurns !== "number" ||
    !isObject(value.runtime.toolBudget) ||
    typeof value.runtime.toolBudget.soft !== "number" ||
    typeof value.runtime.toolBudget.hard !== "number" ||
    !Array.isArray(value.runtime.toolBudget.block)
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid budget section.",
    );
  }

  // Validate verification section.
  if (
    !isObject(value.verification) ||
    !Array.isArray(value.verification.commands) ||
    typeof value.verification.criticRequired !== "boolean" ||
    typeof value.verification.maxRepairAttempts !== "number"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: invalid verification section.",
    );
  }

  // Validate top-level fields.
  if (
    typeof value.capabilityTokenHash !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new ContractStoreError(
      "invalid-artifact",
      "Contract artifact is malformed: missing required top-level fields.",
    );
  }

  return value as unknown as ContractArtifact;
}

function decodeResult(
  value: unknown,
): ContractResult {
  if (
    !isObject(value) ||
    value.version !== 1 ||
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
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = id;
    const previous =
      this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;

    const current = new Promise<void>(
      (resolve) => {
        release = resolve;
      },
    );

    this.locks.set(
      key,
      previous.then(() => current),
    );

    await previous;

    try {
      return await operation();
    } finally {
      release();

      // Clean up the lock entry only if our promise is still
      // the current one (avoids removing a newer lock's entry).
      if (this.locks.get(key) === current) {
        this.locks.delete(key);
      }
    }
  }

  async create(
    artifact: ContractArtifact,
  ): Promise<PendingContractResult> {
    return this.exclusive(
      artifact.id,
      async () => {
        const directory =
          this.contractDirectory(artifact.id);

        if (fs.existsSync(directory)) {
          throw new ContractStoreError(
            "revision-conflict",
            `Contract ${artifact.id} already exists.`,
          );
        }

        fs.mkdirSync(directory, {
          recursive: false,
          mode: 0o700,
        });

        const pending: PendingContractResult = {
          version: 1,
          state: "pending",
          contractId: artifact.id,
          revision: 0,
          createdAt: artifact.createdAt,
        };

        atomicWriteJson(
          this.artifactPath(artifact.id),
          artifact,
        );

        atomicWriteJson(
          this.resultPath(artifact.id),
          pending,
        );

        return pending;
      },
    );
  }

  async load(
    id: ContractId,
  ): Promise<
    PersistedContractDirectory | undefined
  > {
    const artifactPath = this.artifactPath(id);
    const resultPath = this.resultPath(id);

    if (!fs.existsSync(artifactPath)) {
      return undefined;
    }

    try {
      const artifact = decodeArtifact(
        JSON.parse(
          fs.readFileSync(
            artifactPath,
            "utf-8",
          ),
        ),
      );

      const result = decodeResult(
        JSON.parse(
          fs.readFileSync(
            resultPath,
            "utf-8",
          ),
        ),
      );

      return {
        artifact,
        result,
      };
    } catch (error) {
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
          version: 1,
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
      },
    );
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
          version: 1,
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
