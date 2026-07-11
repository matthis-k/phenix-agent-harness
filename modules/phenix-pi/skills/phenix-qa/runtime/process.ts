/**
 * Phenix QA — Process execution with AbortSignal support.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessResult, ProcessRunner } from "./types.ts";

export const DEFAULT_PROCESS_RUNNER: ProcessRunner = {
  async exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProcessResult> {
    const start = Date.now();
    let timedOut = false;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child: ChildProcess = spawn(command, [...args], {
        cwd: options?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        // Limit captured output to prevent memory issues
        if (stdout.length < 500_000) {
          stdout += text;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (stderr.length < 500_000) {
          stderr += text;
        }
      });

      let resolved = false;

      function finish(
        exitCode: number | null,
        signal: string | null,
      ): void {
        if (resolved) return;
        resolved = true;
        const result: ProcessResult = {
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
        };
        resolve(result);
      }

      child.on("close", (exitCode, exitSignal) => {
        finish(exitCode, exitSignal);
      });

      child.on("error", (error) => {
        if (resolved) return;
        resolved = true;
        reject(error);
      });

      // AbortSignal handling
      if (options?.signal) {
        const onAbort = () => {
          if (!resolved) {
            child.kill("SIGTERM");
            // Give it a brief moment, then SIGKILL
            setTimeout(() => {
              if (!resolved) {
                child.kill("SIGKILL");
              }
            }, 3_000);
          }
        };

        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      // Timeout handling
      const timeoutMs = options?.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        const timeout = setTimeout(() => {
          timedOut = true;
          if (!resolved) {
            child.kill("SIGTERM");
            setTimeout(() => {
              if (!resolved) {
                child.kill("SIGKILL");
              }
            }, 3_000);
          }
        }, timeoutMs);

        child.on("close", () => clearTimeout(timeout));
      }
    });
  },
};
