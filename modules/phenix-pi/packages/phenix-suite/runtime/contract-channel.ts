/**
 * contract-channel — closure-bound contract submission channel
 *
 * Wraps a FileContractStore for one specific contract. The completion tool
 * closes over this channel to submit, reopen, accept, or cancel without
 * consulting process-global state.
 *
 * Contract lifecycle:
 *   pending   → submitted
 *   submitted → accepted
 *   submitted → pending     via reopen, with rejection history
 *   pending   → cancelled
 *   submitted → cancelled
 *
 * Invalid schema submissions never leave "pending"; the completion tool
 * returns validation errors directly without calling submit().
 */

import type { ContractArtifact, ContractId } from "../subagents/contract.ts";
import { ContractStoreError, type FileContractStore } from "../subagents/contract-store.ts";
import type {
  ActiveContractAttempt,
  ContractResultState,
  ContractSubmissionChannel,
  ContractSubmissionResult,
  ExecutionIssue,
} from "./child-session-types.ts";

// ── Channel implementation ──────────────────────────────────────────────────

export class ContractSubmissionChannelImpl implements ContractSubmissionChannel {
  private readonly store: FileContractStore;
  private readonly contractId: ContractId;
  private readonly artifact: ContractArtifact;
  private _cached: ActiveContractAttempt;

  constructor(store: FileContractStore, artifact: ContractArtifact) {
    this.store = store;
    this.contractId = artifact.id;
    this.artifact = artifact;
    this._cached = {
      contractId: this.contractId,
      state: "pending",
      revision: 0,
      outputSchema: this.artifact.assignment.outputSchema,
    };
  }

  current(): ActiveContractAttempt {
    return this._cached;
  }

  async submit(value: unknown): Promise<ContractSubmissionResult> {
    try {
      const current = await this.store.load(this.contractId);
      if (!current) {
        return {
          ok: false,
          state: "cancelled",
          revision: 0,
        };
      }

      if (current.result.state !== "pending") {
        this._cached = {
          contractId: this.contractId,
          state: current.result.state as ContractResultState,
          revision: current.result.revision,
          outputSchema: this.artifact.assignment.outputSchema,
        };
        return {
          ok: false,
          state: current.result.state as ContractResultState,
          revision: current.result.revision,
        };
      }

      const submitted = await this.store.submit(this.contractId, current.result.revision, value);

      this._cached = {
        contractId: this.contractId,
        state: "submitted",
        revision: submitted.revision,
        outputSchema: this.artifact.assignment.outputSchema,
      };

      return {
        ok: true,
        state: "submitted",
        revision: submitted.revision,
      };
    } catch (error) {
      if (error instanceof ContractStoreError) {
        const cause = "cause" in error ? error.cause : undefined;
        const causeMessage =
          cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
        return {
          ok: false,
          state: "cancelled" as ContractResultState,
          revision: 0,
          ...(error.message
            ? {
                issues: [
                  {
                    path: ["store"],
                    message: error.message + (causeMessage ? ` Cause: ${causeMessage}` : ""),
                  },
                ],
              }
            : {}),
        };
      }
      throw error;
    }
  }

  async reopen(input: {
    readonly reason: "runtime-validation" | "verification" | "critic";
    readonly issues: readonly ExecutionIssue[];
  }): Promise<void> {
    const current = await this.store.load(this.contractId);
    if (!current) return;

    if (current.result.state !== "submitted") return;

    const disposition =
      input.reason === "runtime-validation"
        ? "runtime-rejected"
        : input.reason === "verification"
          ? "verification-rejected"
          : "critic-rejected";

    await this.store.reopen(this.contractId, current.result.revision, disposition, input.issues);

    this._cached = {
      contractId: this.contractId,
      state: "pending",
      revision: current.result.revision + 1,
      outputSchema: this.artifact.assignment.outputSchema,
    };
  }

  async accept(_value: unknown): Promise<void> {
    const current = await this.store.load(this.contractId);
    if (!current) return;

    if (current.result.state !== "submitted") return;

    await this.store.accept(this.contractId, current.result.revision);

    this._cached = {
      contractId: this.contractId,
      state: "accepted",
      revision: current.result.revision + 1,
      outputSchema: this.artifact.assignment.outputSchema,
    };
  }

  async cancel(reason: string): Promise<void> {
    const current = await this.store.load(this.contractId);
    if (!current) return;

    if (current.result.state === "accepted" || current.result.state === "cancelled") return;

    await this.store.cancel(this.contractId, reason);

    this._cached = {
      contractId: this.contractId,
      state: "cancelled",
      revision: current.result.revision + 1,
      outputSchema: this.artifact.assignment.outputSchema,
    };
  }

  async readSubmitted(): Promise<
    { readonly value: unknown; readonly revision: number } | undefined
  > {
    const current = await this.store.load(this.contractId);
    if (!current) return undefined;

    if (current.result.state === "submitted" || current.result.state === "accepted") {
      return {
        value: current.result.value,
        revision: current.result.revision,
      };
    }

    return undefined;
  }
}
