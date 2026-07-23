export interface LocalOperationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface LocalOperationRunner {
  has(operation: string): boolean;
  run(operation: string, input: unknown, context: LocalOperationContext): Promise<unknown>;
}
