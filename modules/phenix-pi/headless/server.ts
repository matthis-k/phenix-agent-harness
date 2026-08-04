import { JsonlDecodeError, JsonlDecoder, serializeJsonLine } from "./jsonl.ts";
import {
  parseHeadlessRequest,
  type HeadlessCommand,
  type HeadlessEventFrame,
  type HeadlessOutboundFrame,
  type HeadlessProtocolError,
  type HeadlessRequestFrame,
  type HeadlessResponseFrame,
} from "./protocol.ts";

export interface HeadlessCommandExecutor {
  execute(command: HeadlessCommand): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface HeadlessProtocolServerOptions {
  readonly executor: HeadlessCommandExecutor;
  readonly write: (line: string) => void | Promise<void>;
  readonly maxFrameBytes?: number;
}

export class HeadlessCommandError extends Error {
  readonly code: HeadlessProtocolError["code"];
  readonly retryable: boolean;

  constructor(input: {
    readonly code: HeadlessProtocolError["code"];
    readonly message: string;
    readonly retryable?: boolean;
  }) {
    super(input.message);
    this.name = "HeadlessCommandError";
    this.code = input.code;
    this.retryable = input.retryable ?? false;
  }
}

export class HeadlessProtocolServer {
  readonly #executor: HeadlessCommandExecutor;
  readonly #write: (line: string) => void | Promise<void>;
  readonly #decoder: JsonlDecoder;
  readonly #inFlightIds = new Set<string>();
  readonly #inFlight = new Set<Promise<void>>();
  #writeChain: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: HeadlessProtocolServerOptions) {
    this.#executor = options.executor;
    this.#write = options.write;
    this.#decoder = new JsonlDecoder(options.maxFrameBytes);
  }

  async accept(chunk: Uint8Array | string): Promise<void> {
    this.assertOpen();
    let values: readonly unknown[];
    try {
      values = this.#decoder.push(chunk);
    } catch (error: unknown) {
      await this.publishProtocolFailure(error);
      return;
    }
    await Promise.all(values.map((value) => this.dispatch(value)));
  }

  async finish(): Promise<void> {
    this.assertOpen();
    let values: readonly unknown[];
    try {
      values = this.#decoder.finish();
    } catch (error: unknown) {
      await this.publishProtocolFailure(error);
      values = [];
    }
    await Promise.all(values.map((value) => this.dispatch(value)));
    await Promise.all([...this.#inFlight]);
    await this.#writeChain;
  }

  publish(event: unknown): Promise<void> {
    return this.enqueue({ kind: "event", event } satisfies HeadlessEventFrame);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.finish();
    this.#disposed = true;
    await this.#executor.dispose();
    await this.#writeChain;
  }

  private dispatch(value: unknown): Promise<void> {
    const task = this.handleValue(value);
    this.#inFlight.add(task);
    void task.then(
      () => this.#inFlight.delete(task),
      () => this.#inFlight.delete(task),
    );
    return task;
  }

  private async handleValue(value: unknown): Promise<void> {
    let request: HeadlessRequestFrame;
    try {
      request = parseHeadlessRequest(value);
    } catch (error: unknown) {
      await this.publishProtocolFailure(error);
      return;
    }

    if (this.#inFlightIds.has(request.id)) {
      await this.enqueue(
        failedResponse(request.id, {
          code: "invalid_state",
          message: `Request ID is already in flight`,
          retryable: true,
        }),
      );
      return;
    }

    this.#inFlightIds.add(request.id);
    try {
      const reply = await this.#executor.execute(request.command);
      await this.enqueue({
        kind: "response",
        id: request.id,
        result: { ok: true, reply },
      } satisfies HeadlessResponseFrame);
    } catch (error: unknown) {
      await this.enqueue(failedResponse(request.id, commandError(error)));
    } finally {
      this.#inFlightIds.delete(request.id);
    }
  }

  private publishProtocolFailure(error: unknown): Promise<void> {
    const message =
      error instanceof JsonlDecodeError || error instanceof Error
        ? error.message
        : `Invalid protocol input`;
    return this.publish({
      type: "protocol.error",
      error: {
        code: "invalid_frame",
        message,
        retryable: false,
      } satisfies HeadlessProtocolError,
    });
  }

  private enqueue(frame: HeadlessOutboundFrame): Promise<void> {
    const line = serializeJsonLine(frame);
    const write = this.#writeChain.then(async () => {
      await this.#write(line);
    });
    this.#writeChain = write.catch(() => undefined);
    return write;
  }

  private assertOpen(): void {
    if (this.#disposed) throw new Error(`Headless protocol server is disposed`);
  }
}

function failedResponse(id: string, error: HeadlessProtocolError): HeadlessResponseFrame {
  return {
    kind: "response",
    id,
    result: { ok: false, error },
  };
}

function commandError(error: unknown): HeadlessProtocolError {
  if (error instanceof HeadlessCommandError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "backend_failure",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
