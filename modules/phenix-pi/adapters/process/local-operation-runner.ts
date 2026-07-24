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

export type DeterministicCheck =
  | { readonly kind: "nix-flake-check" }
  | { readonly kind: "devenv-maintenance-fix" }
  | { readonly kind: "devenv-test" }
  | {
      readonly kind: "package-script";
      readonly manager: "npm" | "pnpm" | "yarn";
      readonly script: "test" | "typecheck" | "lint" | "check";
    }
  | { readonly kind: "cargo-test" }
  | { readonly kind: "cargo-clippy" }
  | { readonly kind: "pytest" }
  | { readonly kind: "go-test" };

interface CheckInvocation {
  readonly display: string;
  readonly executable: string;
  readonly args: readonly string[];
}

interface CheckExecutionOptions {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
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

    const requested = configuredChecks(input);
    const checks = (requested.length > 0 ? requested : discoverChecks(context.cwd)).slice(
      0,
      MAX_CHECKS,
    );
    if (checks.length === 0) {
      return [
        {
          command: "<automatic discovery>",
          ok: false,
          summary: "No deterministic project check was discovered for this repository.",
        },
      ];
    }

    const results = [];
    for (const check of checks) {
      results.push(await runCheck(compileDeterministicCheck(check), context, this.execute));
    }
    return results;
  }
}

async function runCheck(
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
      command: invocation.display,
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
      command: invocation.display,
      ok: false,
      summary: bounded(
        output ||
          `${failure.message}${failure.code === undefined ? "" : ` (exit ${failure.code})`}`,
      ),
    };
  }
}

function discoverChecks(cwd: string): readonly DeterministicCheck[] {
  const checks: DeterministicCheck[] = [];
  const hasDevenv =
    existsSync(path.join(cwd, "devenv.nix")) || existsSync(path.join(cwd, "devenv.yaml"));
  if (hasDevenv) {
    checks.push({ kind: "devenv-maintenance-fix" }, { kind: "devenv-test" });
  }
  if (existsSync(path.join(cwd, "flake.nix"))) checks.push({ kind: "nix-flake-check" });
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    checks.push({ kind: "cargo-test" }, { kind: "cargo-clippy" });
  }
  if (existsSync(path.join(cwd, "go.mod"))) checks.push({ kind: "go-test" });
  if (existsSync(path.join(cwd, "pyproject.toml"))) checks.push({ kind: "pytest" });

  const packageJson = path.join(cwd, "package.json");
  if (existsSync(packageJson)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
        readonly scripts?: Readonly<Record<string, string>>;
      };
      for (const script of ["test", "typecheck", "lint", "check"] as const) {
        if (parsed.scripts?.[script]) {
          checks.push({ kind: "package-script", manager: "npm", script });
        }
      }
    } catch {
      checks.push({ kind: "package-script", manager: "npm", script: "test" });
    }
  }
  return checks;
}

function configuredChecks(input: unknown): readonly DeterministicCheck[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as { readonly checks?: unknown; readonly commands?: unknown };
  if (record.commands !== undefined) {
    throw new Error("Configured QA checks must use structured check objects, not command strings");
  }
  if (record.checks === undefined) return [];
  if (!Array.isArray(record.checks)) throw new Error("Configured QA checks must be an array");
  return record.checks.map(parseDeterministicCheck);
}

export function parseDeterministicCheck(value: unknown): DeterministicCheck {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Deterministic QA check must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  switch (record.kind) {
    case "nix-flake-check":
    case "devenv-maintenance-fix":
    case "devenv-test":
    case "cargo-test":
    case "cargo-clippy":
    case "pytest":
    case "go-test":
      return { kind: record.kind };
    case "package-script": {
      if (!["npm", "pnpm", "yarn"].includes(String(record.manager))) {
        throw new Error("Package-script check has an unsupported package manager");
      }
      if (!["test", "typecheck", "lint", "check"].includes(String(record.script))) {
        throw new Error("Package-script check has an unsupported script");
      }
      return {
        kind: "package-script",
        manager: record.manager as "npm" | "pnpm" | "yarn",
        script: record.script as "test" | "typecheck" | "lint" | "check",
      };
    }
    default:
      throw new Error(`Unknown deterministic QA check kind: ${String(record.kind)}`);
  }
}

export function compileDeterministicCheck(check: DeterministicCheck): CheckInvocation {
  switch (check.kind) {
    case "nix-flake-check":
      return {
        display: "nix flake check --accept-flake-config --print-build-logs --keep-going",
        executable: "nix",
        args: ["flake", "check", "--accept-flake-config", "--print-build-logs", "--keep-going"],
      };
    case "devenv-maintenance-fix":
      return {
        display: "devenv tasks run maintenance:fix",
        executable: "devenv",
        args: ["tasks", "run", "maintenance:fix"],
      };
    case "devenv-test":
      return { display: "devenv test", executable: "devenv", args: ["test"] };
    case "package-script": {
      const args =
        check.script === "test" ? ["test", "--if-present"] : ["run", check.script, "--if-present"];
      return {
        display: `${check.manager} ${args.join(" ")}`,
        executable: check.manager,
        args,
      };
    }
    case "cargo-test":
      return {
        display: "cargo test --all-targets",
        executable: "cargo",
        args: ["test", "--all-targets"],
      };
    case "cargo-clippy":
      return {
        display: "cargo clippy --all-targets -- -D warnings",
        executable: "cargo",
        args: ["clippy", "--all-targets", "--", "-D", "warnings"],
      };
    case "pytest":
      return { display: "python -m pytest", executable: "python", args: ["-m", "pytest"] };
    case "go-test":
      return { display: "go test ./...", executable: "go", args: ["test", "./..."] };
  }
}

function bounded(value: string): string {
  return value.length <= MAX_SUMMARY ? value : `${value.slice(0, MAX_SUMMARY)}\n… truncated`;
}
