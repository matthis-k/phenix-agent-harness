import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const PREVIEW_LIMIT = 120;

export function streamTraceEnabled(): boolean {
  return Boolean(process.env.PHENIX_PI_STREAM_TRACE);
}

export function streamTraceReasoningEnabled(): boolean {
  return process.env.PHENIX_PI_STREAM_TRACE_REASONING === "1";
}

export function newStreamTraceId(): string {
  return randomUUID();
}

export function streamTraceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function streamTracePreview(value: string): string {
  const escaped = JSON.stringify(value.slice(0, PREVIEW_LIMIT));
  return escaped.slice(1, -1);
}

export function writeStreamTrace(record: Record<string, unknown>): void {
  const tracePath = process.env.PHENIX_PI_STREAM_TRACE;
  if (!tracePath) return;
  appendFileSync(
    tracePath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
