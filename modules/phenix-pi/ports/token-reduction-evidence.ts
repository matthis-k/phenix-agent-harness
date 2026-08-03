import type { RunId } from "../domain/shared.ts";

export interface CaptureReducedToolEvidenceInput {
  readonly runId: RunId;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly isError: boolean;
}

export interface TokenReductionEvidenceStore {
  captureToolResult(input: CaptureReducedToolEvidenceInput): Promise<{ readonly id: string }>;
}
