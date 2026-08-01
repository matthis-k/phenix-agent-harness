export interface LocalOperationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** Stable for one workflow-node activation and reused after recovery. */
  readonly executionId: string;
}

export interface LocalOperationRunner {
  has(operation: string): boolean;
  run(operation: string, input: unknown, context: LocalOperationContext): Promise<unknown>;
}
