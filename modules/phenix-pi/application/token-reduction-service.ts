import type {
  TokenReductionMetrics,
  TokenReductionPreparation,
  TokenReductionResult,
  TokenReductionRewrite,
} from "../domain/token-reduction.ts";
import type { RunId } from "../domain/shared.ts";
import type { TokenReductionBackend } from "../ports/token-reduction-backend.ts";
import type { TokenReductionEvidenceStore } from "../ports/token-reduction-evidence.ts";

const RTK_RECOVERY_HINT = /^\[(?:full output|see remaining):[^\]]+\]\s*$/gim;

export interface CompleteReducedToolResultInput {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly content: readonly unknown[];
  readonly details?: unknown;
  readonly isError: boolean;
}

export class TokenReductionService {
  private readonly runId: RunId;
  private readonly cwd: string;
  private readonly evidence: TokenReductionEvidenceStore;
  private readonly backend?: TokenReductionBackend;
  private readonly pending = new Map<string, TokenReductionRewrite>();

  constructor(input: {
    readonly runId: RunId;
    readonly cwd: string;
    readonly evidence: TokenReductionEvidenceStore;
    readonly backend?: TokenReductionBackend;
  }) {
    this.runId = input.runId;
    this.cwd = input.cwd;
    this.evidence = input.evidence;
    this.backend = input.backend;
  }

  async prepareBash(
    toolCallId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<TokenReductionPreparation> {
    if (!this.backend) return { kind: "passthrough", reason: "disabled" };
    let preparation: TokenReductionPreparation;
    try {
      preparation = await this.backend.prepare({
        runId: this.runId,
        toolCallId,
        cwd: this.cwd,
        command,
        ...(signal ? { signal } : {}),
      });
    } catch {
      return {
        kind: "passthrough",
        backend: this.backend.id,
        reason: "backend-unavailable",
      };
    }
    if (preparation.kind === "rewrite") this.pending.set(toolCallId, preparation);
    return preparation;
  }

  async complete(input: CompleteReducedToolResultInput): Promise<TokenReductionResult | undefined> {
    const preparation = this.pending.get(input.toolCallId);
    const backend = this.backend;
    if (!preparation || !backend) return undefined;
    this.pending.delete(input.toolCallId);

    const reducedContent = sanitizeRecoveryHints(input.content);
    try {
      const recovered = await backend.recover(preparation).catch(() => undefined);
      if (!recovered) return nonLosslessResult(input.details, preparation.backend, reducedContent);

      const reducedBytes = encodedBytes(reducedContent);
      const originalBytes = Buffer.byteLength(recovered.content, "utf8");
      const savedBytes = Math.max(0, originalBytes - reducedBytes);
      const reductionMetrics: TokenReductionMetrics = {
        backend: preparation.backend,
        originalBytes,
        reducedBytes,
        savedBytes,
        estimatedTokensSaved: Math.ceil(savedBytes / 4),
        lossless: recovered.complete,
      };
      const evidence = await this.evidence
        .captureToolResult({
          runId: this.runId,
          toolName: input.toolName,
          toolCallId: input.toolCallId,
          input: restoreOriginalCommand(input.input, preparation.originalCommand),
          content: [{ type: "text" as const, text: recovered.content }],
          details: mergeDetails(input.details, reductionMetrics),
          isError: input.isError,
        })
        .catch(() => undefined);
      if (!evidence) return nonLosslessResult(input.details, preparation.backend, reducedContent);

      const metrics: TokenReductionMetrics = {
        ...reductionMetrics,
        evidenceId: evidence.id,
      };
      return {
        content: appendEvidenceReceipt(reducedContent, metrics),
        details: mergeDetails(input.details, metrics),
        metrics,
      };
    } finally {
      await backend.cleanup(preparation).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    const backend = this.backend;
    if (!backend) return;
    await Promise.all(pending.map((item) => backend.cleanup(item).catch(() => undefined)));
  }
}

function nonLosslessResult(
  details: unknown,
  backend: string,
  content: readonly unknown[],
): TokenReductionResult {
  const metrics: TokenReductionMetrics = {
    backend,
    reducedBytes: encodedBytes(content),
    savedBytes: 0,
    estimatedTokensSaved: 0,
    lossless: false,
  };
  return {
    content,
    details: mergeDetails(details, metrics),
    metrics,
  };
}

function restoreOriginalCommand(input: unknown, originalCommand: string): unknown {
  const record = recordOf(input);
  return record ? { ...record, command: originalCommand } : { command: originalCommand };
}

function sanitizeRecoveryHints(content: readonly unknown[]): readonly unknown[] {
  return content.map((part) => {
    const record = recordOf(part);
    if (record?.type !== "text" || typeof record.text !== "string") return part;
    const text = record.text.replace(RTK_RECOVERY_HINT, "").trimEnd();
    return { ...record, text };
  });
}

function appendEvidenceReceipt(
  content: readonly unknown[],
  metrics: TokenReductionMetrics,
): readonly unknown[] {
  if (!metrics.evidenceId) return content;
  const receipt =
    `Phenix ${metrics.backend}: ${metrics.originalBytes ?? 0} → ${metrics.reducedBytes} bytes; ` +
    `exact evidence ${metrics.evidenceId}. ` +
    `Use phenix_memory action=read evidenceId=${metrics.evidenceId}.`;
  return [...content, { type: "text" as const, text: receipt }];
}

function mergeDetails(details: unknown, metrics: TokenReductionMetrics): Readonly<Record<string, unknown>> {
  const base = recordOf(details) ?? {};
  return { ...base, phenixTokenReduction: metrics };
}

function encodedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
