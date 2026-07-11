import { spawn } from "node:child_process";
import path from "node:path";

import type { VerificationCommand } from "./policy.ts";

export interface VerificationRun {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: "passed" | "failed" | "timed-out" | "allowed-failure" | "cancelled";
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly durationMs: number;
}

const MAX_CAPTURE_BYTES = 16 * 1024;

function compact(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (Buffer.byteLength(trimmed, "utf-8") <= MAX_CAPTURE_BYTES) return trimmed;
  return `${Buffer.from(trimmed, "utf-8").subarray(0, MAX_CAPTURE_BYTES).toString("utf-8")}\n...[truncated]`;
}

function runOne(
  command: VerificationCommand,
  defaultCwd: string,
  signal: AbortSignal,
): Promise<VerificationRun> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const cwd = command.cwd ? path.resolve(defaultCwd, command.cwd) : defaultCwd;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let hardKill: NodeJS.Timeout | undefined;

    const child = spawn(command.command, {
      cwd,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      signal.removeEventListener("abort", abort);
      if (spawnError) stderr = stderr ? `${stderr}\n${spawnError}` : spawnError;
      const failed = exitCode !== 0;
      resolve({
        id: command.id,
        command: command.command,
        cwd,
        status: cancelled
          ? "cancelled"
          : timedOut
            ? "timed-out"
            : failed
              ? command.allowFailure
                ? "allowed-failure"
                : "failed"
              : "passed",
        exitCode,
        ...(compact(stdout) ? { stdout: compact(stdout) } : {}),
        ...(compact(stderr) ? { stderr: compact(stderr) } : {}),
        durationMs: Date.now() - startedAt,
      });
    };

    const terminate = (reason: "timeout" | "cancel"): void => {
      if (settled) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancel";
      child.kill("SIGTERM");
      hardKill = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish(null, reason === "timeout" ? "verification timed out" : "verification cancelled");
      }, 1_000);
      hardKill.unref?.();
    };

    const abort = () => terminate("cancel");
    const timeout = setTimeout(
      () => terminate("timeout"),
      command.timeoutMs ?? 120_000,
    );
    timeout.unref?.();

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf-8") < MAX_CAPTURE_BYTES * 2) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, "utf-8") < MAX_CAPTURE_BYTES * 2) stderr += chunk.toString();
    });
    child.on("close", (code) => finish(code));
    child.on("error", (error) => finish(1, error.message));
  });
}

export async function runVerificationCommands(
  commands: readonly VerificationCommand[],
  cwd: string,
  signal: AbortSignal,
): Promise<VerificationRun[]> {
  const results: VerificationRun[] = [];
  for (const command of commands) {
    if (signal.aborted) break;
    const result = await runOne(command, cwd, signal);
    results.push(result);
    if (result.status === "failed" || result.status === "timed-out" || result.status === "cancelled") break;
  }
  return results;
}
