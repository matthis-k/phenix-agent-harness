import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  LocalOperationContext,
  LocalOperationRunner,
} from "../../ports/local-operation-runner.ts";

const execFileAsync = promisify(execFile);

export class ProcessLocalOperationRunner implements LocalOperationRunner {
  has(operation: string): boolean {
    return (
      operation === "local.noop" || operation === "local.command" || operation === "local.check"
    );
  }

  async run(operation: string, input: unknown, context: LocalOperationContext): Promise<unknown> {
    if (operation === "local.noop") return input;
    if (operation !== "local.command" && operation !== "local.check") {
      throw new Error(`Unknown local operation: ${operation}`);
    }
    if (!isCommandInput(input)) throw new Error(`${operation} requires { command: string }`);
    const result = await execFileAsync("/bin/bash", ["-lc", input.command], {
      cwd: context.cwd,
      signal: context.signal,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      command: input.command,
      stdout: result.stdout,
      stderr: result.stderr,
      ok: true,
    };
  }
}

function isCommandInput(
  value: unknown,
): value is { readonly command: string; readonly timeoutMs?: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { command?: unknown }).command === "string" &&
    ((value as { timeoutMs?: unknown }).timeoutMs === undefined ||
      typeof (value as { timeoutMs?: unknown }).timeoutMs === "number")
  );
}
