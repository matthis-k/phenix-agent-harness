import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class JsonlDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlDecodeError";
  }
}

export class JsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxFrameBytes: number;
  #buffer = "";

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError(`maxFrameBytes must be a positive safe integer`);
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array | string): readonly unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    const frames = this.drainCompleteFrames();
    this.assertIncompleteFrameBound();
    return frames;
  }

  finish(): readonly unknown[] {
    this.#buffer += this.#decoder.end();
    const frames = [...this.drainCompleteFrames()];
    this.assertIncompleteFrameBound();
    if (this.#buffer.length === 0) return frames;
    frames.push(parseLine(this.#buffer, this.#maxFrameBytes));
    this.#buffer = "";
    return frames;
  }

  private drainCompleteFrames(): readonly unknown[] {
    const frames: unknown[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return frames;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0 || line === "\r") continue;
      frames.push(parseLine(line, this.#maxFrameBytes));
    }
  }

  private assertIncompleteFrameBound(): void {
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxFrameBytes) {
      throw new JsonlDecodeError(`JSONL frame exceeds ${this.#maxFrameBytes} bytes`);
    }
  }
}

export function serializeJsonLine(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new JsonlDecodeError(`JSONL value is not serializable`);
  return `${encoded}\n`;
}

function parseLine(line: string, maxFrameBytes: number): unknown {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (Buffer.byteLength(normalized, "utf8") > maxFrameBytes) {
    throw new JsonlDecodeError(`JSONL frame exceeds ${maxFrameBytes} bytes`);
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new JsonlDecodeError(`Invalid JSONL frame: ${detail}`);
  }
}
