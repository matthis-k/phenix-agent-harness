import type {
  RecoveredTokenReductionOutput,
  TokenReductionBackendId,
  TokenReductionPreparation,
  TokenReductionRewrite,
} from "../domain/token-reduction.ts";
import type { RunId } from "../domain/shared.ts";

export interface PrepareTokenReductionInput {
  readonly runId: RunId;
  readonly toolCallId: string;
  readonly cwd: string;
  readonly command: string;
  readonly signal?: AbortSignal;
}

export interface TokenReductionBackend {
  readonly id: TokenReductionBackendId;
  prepare(input: PrepareTokenReductionInput): Promise<TokenReductionPreparation>;
  recover(preparation: TokenReductionRewrite): Promise<RecoveredTokenReductionOutput | undefined>;
  cleanup(preparation: TokenReductionRewrite): Promise<void>;
}
