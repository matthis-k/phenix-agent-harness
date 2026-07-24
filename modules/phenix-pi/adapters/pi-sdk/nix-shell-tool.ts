import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const NIX_INDEX_DATABASE = "github:nix-community/nix-index-database";
const DEFAULT_COMMAND_TIMEOUT_MS = 1_800_000;
const MAX_COMMAND_TIMEOUT_MS = 14_400_000;
const DEFAULT_INDEX_TIMEOUT_MS = 900_000;
const MAX_INDEX_TIMEOUT_MS = 3_600_000;
const MAX_OUTPUT = 8_000;

interface NixShellInput {
  readonly packages?: readonly string[];
  readonly binaries?: readonly string[];
  readonly command: string;
  readonly timeoutMs?: number;
  readonly indexTimeoutMs?: number;
}

export function createNixShellTool(cwd: string): ToolDefinition {
  return {
    name: "nix_shell",
    label: "Nix Shell",
    description:
      "Run a command in an ephemeral `nix shell` with explicit packages or binary names resolved through nix-index. This never installs packages into a profile or the host system and has the same command-execution authority as bash.",
    promptSnippet:
      "Use nix_shell when a required CLI is missing. Prefer `binaries` when you know the executable name but not its Nix package; use `packages` for explicit installables. Packages are provided ephemerally and are not installed into a profile.",
    parameters: Type.Object({
      packages: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1,
          maxItems: 32,
          description:
            "Nix installables. Bare package names such as `ripgrep` become `nixpkgs#ripgrep`; explicit flake installables are preserved.",
        }),
      ),
      binaries: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          minItems: 1,
          maxItems: 16,
          description:
            "Executable basenames such as `rg`. Each is resolved to a unique nixpkgs package through nix-index-database; ambiguous results must be supplied explicitly through `packages`.",
        }),
      ),
      command: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description: "Shell command to execute inside the ephemeral environment.",
      }),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_COMMAND_TIMEOUT_MS,
          default: DEFAULT_COMMAND_TIMEOUT_MS,
          description: "Command timeout in milliseconds. Defaults to 30 minutes; maximum 4 hours.",
        }),
      ),
      indexTimeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_INDEX_TIMEOUT_MS,
          default: DEFAULT_INDEX_TIMEOUT_MS,
          description:
            "Timeout for each nix-index binary lookup in milliseconds. Defaults to 15 minutes; maximum 1 hour.",
        }),
      ),
    }),
    async execute(_toolCallId, rawInput, signal) {
      const input = requireInput(rawInput);
      const resolvedBinaries = await resolveNixBinaries(
        input.binaries ?? [],
        cwd,
        signal,
        input.indexTimeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
      );
      const installables = [
        "nixpkgs#bash",
        ...(input.packages ?? []).map(normalizeNixInstallable),
        ...resolvedBinaries,
      ].filter((value, index, values) => values.indexOf(value) === index);
      const args = [
        "shell",
        "--accept-flake-config",
        ...installables,
        "--command",
        "bash",
        "-lc",
        input.command,
      ];

      try {
        const result = await execFileAsync("nix", args, {
          cwd,
          signal,
          timeout: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        });
        const output = bounded(
          `${String(result.stdout)}${result.stderr ? `\n${String(result.stderr)}` : ""}`.trim() ||
            "Command completed.",
        );
        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            installables,
            binaries: input.binaries ?? [],
            command: input.command,
          },
        };
      } catch (error) {
        throw new Error(formatExecutionFailure("nix shell command", error));
      }
    },
  } as ToolDefinition;
}

export function normalizeNixInstallable(raw: string): string {
  const value = raw.trim();
  if (!value || value.startsWith("-") || /[\s\0]/u.test(value)) {
    throw new Error(`Invalid Nix installable: ${JSON.stringify(raw)}`);
  }
  return value.includes("#") || value.includes(":") || value.startsWith(".")
    ? value
    : `nixpkgs#${value}`;
}

export function normalizeBinaryName(raw: string): string {
  const value = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9+._-]*$/u.test(value)) {
    throw new Error(`Invalid binary name: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function selectBinaryInstallable(binary: string, stdout: string): string {
  const candidates = [
    ...new Set(
      stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].map(normalizeNixInstallable);
  if (candidates.length === 0) {
    throw new Error(
      `nix-index found no nixpkgs package providing binary ${JSON.stringify(binary)}`,
    );
  }
  if (candidates.length > 1) {
    const shown = candidates.slice(0, 12).join(", ");
    const omitted = candidates.length > 12 ? `, and ${candidates.length - 12} more` : "";
    throw new Error(
      `nix-index found multiple packages providing binary ${JSON.stringify(binary)}: ${shown}${omitted}. Select one explicitly through packages.`,
    );
  }
  return candidates[0] as string;
}

async function resolveNixBinaries(
  binaries: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeout: number,
): Promise<readonly string[]> {
  const installables: string[] = [];
  for (const rawBinary of binaries) {
    const binary = normalizeBinaryName(rawBinary);
    try {
      const result = await execFileAsync(
        "nix",
        [
          "run",
          "--accept-flake-config",
          NIX_INDEX_DATABASE,
          "--",
          "--minimal",
          "--no-group",
          "--type",
          "x",
          "--type",
          "s",
          "--whole-name",
          "--at-root",
          `/bin/${binary}`,
        ],
        {
          cwd,
          signal,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      installables.push(selectBinaryInstallable(binary, String(result.stdout)));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("nix-index found")) throw error;
      throw new Error(
        formatExecutionFailure(`nix-index lookup for ${JSON.stringify(binary)}`, error),
      );
    }
  }
  return installables;
}

function requireInput(raw: unknown): NixShellInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("nix_shell input must be an object");
  }
  const input = raw as Partial<NixShellInput>;
  validateStringArray(input.packages, "packages", 32);
  validateStringArray(input.binaries, "binaries", 16);
  if ((input.packages?.length ?? 0) === 0 && (input.binaries?.length ?? 0) === 0) {
    throw new Error("nix_shell requires at least one package or binary");
  }
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    throw new Error("nix_shell requires a non-empty command");
  }
  validateTimeout(input.timeoutMs, "timeoutMs", MAX_COMMAND_TIMEOUT_MS);
  validateTimeout(input.indexTimeoutMs, "indexTimeoutMs", MAX_INDEX_TIMEOUT_MS);
  return input as NixShellInput;
}

function validateStringArray(
  value: readonly string[] | undefined,
  field: string,
  maximum: number,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`nix_shell ${field} must be a non-empty array of at most ${maximum} strings`);
  }
  if (!value.every((entry) => typeof entry === "string")) {
    throw new Error(`nix_shell ${field} must contain only strings`);
  }
}

function validateTimeout(value: number | undefined, field: string, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`nix_shell ${field} must be an integer between 1 and ${maximum}`);
  }
}

function formatExecutionFailure(label: string, error: unknown): string {
  const failure = error as Error & {
    readonly stdout?: string | Buffer;
    readonly stderr?: string | Buffer;
    readonly code?: string | number;
  };
  const stdout = failure.stdout === undefined ? "" : String(failure.stdout);
  const stderr = failure.stderr === undefined ? "" : String(failure.stderr);
  const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
  const suffix = failure.code === undefined ? "" : ` (exit ${failure.code})`;
  return bounded(`${label} failed${suffix}: ${output || failure.message}`);
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n… truncated`;
}
