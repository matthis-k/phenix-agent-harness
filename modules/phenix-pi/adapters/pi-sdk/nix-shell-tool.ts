import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 900_000;
const MAX_OUTPUT = 8_000;

interface NixShellInput {
  readonly packages: readonly string[];
  readonly command: string;
  readonly timeoutMs?: number;
}

export function createNixShellTool(cwd: string): ToolDefinition {
  return {
    name: "nix_shell",
    label: "Nix Shell",
    description:
      "Run a command in an ephemeral `nix shell` with requested packages. Bare package names resolve through nixpkgs. This never installs packages into a profile or the host system and has the same command-execution authority as bash.",
    promptSnippet:
      "Use nix_shell when a required CLI is missing. Declare only the packages needed for the command; packages are provided ephemerally and are not installed into a profile.",
    parameters: Type.Object({
      packages: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        minItems: 1,
        maxItems: 32,
        description:
          "Nix installables. Bare names such as `jq` become `nixpkgs#jq`; explicit flake installables are preserved.",
      }),
      command: Type.String({
        minLength: 1,
        maxLength: 20_000,
        description: "Shell command to execute inside the ephemeral environment.",
      }),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 3_600_000, default: DEFAULT_TIMEOUT_MS }),
      ),
    }),
    async execute(_toolCallId, rawInput, signal) {
      const input = requireInput(rawInput);
      const installables = ["nixpkgs#bash", ...input.packages.map(normalizeNixInstallable)].filter(
        (value, index, values) => values.indexOf(value) === index,
      );
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
          timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        });
        const output = bounded(
          `${String(result.stdout)}${result.stderr ? `\n${String(result.stderr)}` : ""}`.trim() ||
            "Command completed.",
        );
        return {
          content: [{ type: "text" as const, text: output }],
          details: { installables, command: input.command },
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
        const suffix = failure.code === undefined ? "" : ` (exit ${failure.code})`;
        throw new Error(bounded(`nix shell command failed${suffix}: ${output || failure.message}`));
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

function requireInput(raw: unknown): NixShellInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("nix_shell input must be an object");
  }
  const input = raw as Partial<NixShellInput>;
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    throw new Error("nix_shell requires at least one package");
  }
  if (input.packages.length > 32 || !input.packages.every((value) => typeof value === "string")) {
    throw new Error("nix_shell packages must be an array of at most 32 strings");
  }
  if (typeof input.command !== "string" || input.command.trim().length === 0) {
    throw new Error("nix_shell requires a non-empty command");
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000)
  ) {
    throw new Error("nix_shell timeoutMs must be an integer between 1 and 3600000");
  }
  return input as NixShellInput;
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n… truncated`;
}
