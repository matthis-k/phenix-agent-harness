import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type {
  LocalOperationContext,
  LocalOperationRunner,
} from "../../ports/local-operation-runner.ts";

const execFileAsync = promisify(execFile);
const MAX_CHECKS = 6;
const MAX_SUMMARY = 4_000;

interface CheckInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

interface CheckExecutionOptions {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxBuffer: number;
}

interface CheckExecutionResult {
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
}

export type CheckExecutor = (
  executable: string,
  args: readonly string[],
  options: CheckExecutionOptions,
) => Promise<CheckExecutionResult>;

const defaultExecutor: CheckExecutor = async (executable, args, options) =>
  execFileAsync(executable, [...args], options);

export class ProcessLocalOperationRunner implements LocalOperationRunner {
  private readonly execute: CheckExecutor;

  constructor(execute: CheckExecutor = defaultExecutor) {
    this.execute = execute;
  }

  has(operation: string): boolean {
    return operation === "local.noop" || operation === "local.qa-checks";
  }

  async run(operation: string, input: unknown, context: LocalOperationContext): Promise<unknown> {
    if (operation === "local.noop") return input;
    if (operation !== "local.qa-checks") throw new Error(`Unknown local operation: ${operation}`);

    const requested = configuredCommands(input);
    const commands = (requested.length > 0 ? requested : discoverCommands(context.cwd)).slice(
      0,
      MAX_CHECKS,
    );
    if (commands.length === 0) {
      return [
        {
          command: "<automatic discovery>",
          ok: false,
          summary: "No deterministic project check was discovered for this repository.",
        },
      ];
    }

    const results = [];
    for (const command of commands) {
      const invocation = parseApprovedCheckCommand(command);
      results.push(await runCheck(command, invocation, context, this.execute));
    }
    return results;
  }
}

async function runCheck(
  command: string,
  invocation: CheckInvocation,
  context: LocalOperationContext,
  execute: CheckExecutor,
) {
  try {
    const result = await execute(invocation.executable, invocation.args, {
      cwd: context.cwd,
      signal: context.signal,
      timeout: 900_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stdout = String(result.stdout);
    const stderr = String(result.stderr);
    return {
      command,
      ok: true,
      summary: bounded(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim() || "Passed."),
    };
  } catch (error) {
    const failure = error as Error & {
      readonly stdout?: string | Buffer;
      readonly stderr?: string | Buffer;
      readonly code?: string | number;
    };
    const stdout = failure.stdout === undefined ? "" : String(failure.stdout);
    const stderr = failure.stderr === undefined ? "" : String(failure.stderr);
    const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
    return {
      command,
      ok: false,
      summary: bounded(
        output ||
          `${failure.message}${failure.code === undefined ? "" : ` (exit ${failure.code})`}`,
      ),
    };
  }
}

function discoverCommands(cwd: string): readonly string[] {
  const commands: string[] = [];
  if (existsSync(path.join(cwd, "flake.nix"))) {
    commands.push("nix flake check --accept-flake-config --print-build-logs --keep-going");
  }
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    commands.push("cargo test --all-targets", "cargo clippy --all-targets -- -D warnings");
  }
  if (existsSync(path.join(cwd, "go.mod"))) commands.push("go test ./...");
  if (existsSync(path.join(cwd, "pyproject.toml"))) commands.push("python -m pytest");

  const packageJson = path.join(cwd, "package.json");
  if (existsSync(packageJson)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
        readonly scripts?: Readonly<Record<string, string>>;
      };
      if (parsed.scripts?.test) commands.push("npm test --if-present");
      if (parsed.scripts?.typecheck) commands.push("npm run typecheck --if-present");
      if (parsed.scripts?.lint) commands.push("npm run lint --if-present");
    } catch {
      commands.push("npm test --if-present");
    }
  }
  return commands;
}

function configuredCommands(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const commands = (input as { readonly commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  return commands.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

export function parseApprovedCheckCommand(command: string): CheckInvocation {
  assertSafeCheckCommand(command);
  const tokens = tokenizeCommand(command);
  const [executable, ...args] = tokens;
  if (!executable) throw new Error(`Deterministic QA command is empty`);
  return { executable, args };
}

function assertSafeCheckCommand(command: string): void {
  if (/[\n\r;&|`]|\$\(/.test(command)) {
    throw new Error(`Deterministic QA commands may not contain shell composition: ${command}`);
  }
  const allowed = [
    /^nix flake check(?:\s|$)/,
    /^devenv test(?:\s|$)/,
    /^npm (?:test|run (?:test|typecheck|lint|check))(?:\s|$)/,
    /^pnpm (?:test|run (?:test|typecheck|lint|check))(?:\s|$)/,
    /^yarn (?:test|run (?:test|typecheck|lint|check))(?:\s|$)/,
    /^cargo (?:test|clippy)(?:\s|$)/,
    /^(?:python -m )?pytest(?:\s|$)/,
    /^go test(?:\s|$)/,
  ];
  if (!allowed.some((pattern) => pattern.test(command.trim()))) {
    throw new Error(`Command is not an approved deterministic QA check: ${command}`);
  }
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flush = () => {
    if (token.length === 0) return;
    tokens.push(token);
    token = "";
  };

  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    token += character;
  }

  if (escaped) throw new Error(`Deterministic QA command has a trailing escape: ${command}`);
  if (quote) throw new Error(`Deterministic QA command has an unterminated quote: ${command}`);
  flush();
  return tokens;
}

function bounded(value: string): string {
  return value.length <= MAX_SUMMARY ? value : `${value.slice(0, MAX_SUMMARY)}\n… truncated`;
}
