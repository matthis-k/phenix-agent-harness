import type {
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
} from "../../ports/agent-session-backend.ts";

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export class BoundedAgentSessionPort implements AgentSessionPort {
  private readonly inner: AgentSessionPort;
  private readonly cleanupTimeoutMs: number;

  constructor(inner: AgentSessionPort, cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {
    this.inner = inner;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
  }

  get reference(): AgentSessionReference {
    return this.inner.reference;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  prompt(message: string): Promise<void> {
    return this.inner.prompt(message);
  }

  steer(message: string): Promise<void> {
    return this.inner.steer(message);
  }

  followUp(message: string): Promise<void> {
    return this.inner.followUp(message);
  }

  notify(message: string): Promise<void> {
    return this.inner.notify(message);
  }

  abort(): Promise<void> {
    return settleWithin(this.inner.abort(), this.cleanupTimeoutMs, "Pi session abort");
  }

  dispose(): Promise<void> {
    return settleWithin(this.inner.dispose(), this.cleanupTimeoutMs, "Pi session disposal");
  }

  subscribe(listener: (event: AgentSessionObservation) => void): () => void {
    return this.inner.subscribe(listener);
  }
}

export async function settleWithin(
  operation: Promise<void>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  if (timeoutMs <= 0) {
    await operation;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
