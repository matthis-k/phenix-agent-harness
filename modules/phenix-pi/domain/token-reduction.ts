export type TokenReductionBackendId = string;

export type TokenReductionPassthroughReason =
  | "disabled"
  | "unsupported-tool"
  | "empty-command"
  | "already-reduced"
  | "backend-unavailable"
  | "not-reducible"
  | "unsafe-rewrite";

export interface TokenReductionPassthrough {
  readonly kind: "passthrough";
  readonly backend?: TokenReductionBackendId;
  readonly reason: TokenReductionPassthroughReason;
}

export interface TokenReductionRewrite {
  readonly kind: "rewrite";
  readonly backend: TokenReductionBackendId;
  readonly originalCommand: string;
  readonly command: string;
  readonly recoveryKey: string;
}

export type TokenReductionPreparation = TokenReductionPassthrough | TokenReductionRewrite;

export interface RecoveredTokenReductionOutput {
  readonly content: string;
  readonly complete: boolean;
}

export interface TokenReductionMetrics {
  readonly backend: TokenReductionBackendId;
  readonly evidenceId?: string;
  readonly originalBytes?: number;
  readonly reducedBytes: number;
  readonly savedBytes: number;
  readonly estimatedTokensSaved: number;
  readonly lossless: boolean;
}

export interface TokenReductionResult {
  readonly content: readonly unknown[];
  readonly details: unknown;
  readonly metrics: TokenReductionMetrics;
}
