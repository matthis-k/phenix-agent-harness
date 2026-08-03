import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RecoveredTokenReductionOutput,
  TokenReductionPreparation,
  TokenReductionRewrite,
} from "../../domain/token-reduction.ts";
import type {
  PrepareTokenReductionInput,
  TokenReductionBackend,
} from "../../ports/token-reduction-backend.ts";

const REWRITE_TIMEOUT_MS = 2_000;
const LOSSLESS_MARKER = "PHENIX_RTK_LOSSLESS=1";

interface RtkExecutionResult {
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
  readonly code: number;
}

export type RtkExecutor = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly timeout: number;
    readonly maxBuffer: number;
  },
) => Promise<RtkExecutionResult>;

const defaultExecutor: RtkExecutor = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, code: 0 });
        return;
      }
      const code = typeof error.code === "number" ? error.code : undefined;
      if (code !== undefined) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(error);
    });
  });

export class ProcessRtkTokenReductionBackend implements TokenReductionBackend {
  readonly id = "rtk";

  private readonly executable: string;
  private readonly directory: string;
  private readonly execute: RtkExecutor;
  private configReady?: Promise<void>;

  constructor(input: {
    readonly executable: string;
    readonly stateDirectory: string;
    readonly execute?: RtkExecutor;
  }) {
    this.executable = input.executable;
    this.directory = path.join(input.stateDirectory, "token-reduction", "rtk");
    this.execute = input.execute ?? defaultExecutor;
  }

  async prepare(input: PrepareTokenReductionInput): Promise<TokenReductionPreparation> {
    const command = input.command.trim();
    if (process.env.PHENIX_TOKEN_REDUCTION_BACKEND === "none" || process.env.RTK_DISABLED === "1") {
      return { kind: "passthrough", backend: this.id, reason: "disabled" };
    }
    if (!command) return { kind: "passthrough", backend: this.id, reason: "empty-command" };
    if (/^(?:env\s+[^\n]*\s+)?rtk\b/.test(command) || command.includes(LOSSLESS_MARKER)) {
      return { kind: "passthrough", backend: this.id, reason: "already-reduced" };
    }

    await this.ensureConfig();
    let result: RtkExecutionResult;
    try {
      result = await this.execute(this.executable, ["rewrite", command], {
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
        timeout: REWRITE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      return { kind: "passthrough", backend: this.id, reason: "backend-unavailable" };
    }
    if (result.code !== 0 && result.code !== 3) {
      return { kind: "passthrough", backend: this.id, reason: "not-reducible" };
    }

    const rewritten = String(result.stdout).trim();
    if (!rewritten || rewritten === command) {
      return { kind: "passthrough", backend: this.id, reason: "not-reducible" };
    }
    if (rewritten.includes("\0") || rewritten.includes("\n") || rewritten.includes("\r")) {
      return { kind: "passthrough", backend: this.id, reason: "unsafe-rewrite" };
    }

    const recoveryKey = safeKey(`${input.runId}-${input.toolCallId}`);
    const teeDirectory = path.join(this.directory, "pending", recoveryKey);
    await rm(teeDirectory, { recursive: true, force: true });
    await mkdir(teeDirectory, { recursive: true, mode: 0o700 });
    const commandWithRecovery = [
      "env",
      LOSSLESS_MARKER,
      `RTK_TEE_DIR=${shellQuote(teeDirectory)}`,
      `XDG_CONFIG_HOME=${shellQuote(this.configDirectory())}`,
      rewritten,
    ].join(" ");
    return {
      kind: "rewrite",
      backend: this.id,
      originalCommand: command,
      command: commandWithRecovery,
      recoveryKey,
    };
  }

  async recover(preparation: TokenReductionRewrite): Promise<RecoveredTokenReductionOutput | undefined> {
    const directory = path.join(this.directory, "pending", preparation.recoveryKey);
    let entries: string[];
    try {
      entries = (await readdir(directory)).filter((entry) => entry.endsWith(".log"));
    } catch {
      return undefined;
    }
    const candidates = await Promise.all(
      entries.map(async (entry) => {
        try {
          const content = await readFile(path.join(directory, entry), "utf8");
          return {
            content,
            bytes: Buffer.byteLength(content, "utf8"),
          };
        } catch {
          return undefined;
        }
      }),
    );
    const recovered = candidates
      .filter((candidate): candidate is { readonly content: string; readonly bytes: number } =>
        Boolean(candidate),
      )
      .sort((left, right) => right.bytes - left.bytes)[0];
    if (!recovered) return undefined;
    return {
      content: recovered.content,
      complete: !recovered.content.includes("--- truncated at "),
    };
  }

  async cleanup(preparation: TokenReductionRewrite): Promise<void> {
    await rm(path.join(this.directory, "pending", preparation.recoveryKey), {
      recursive: true,
      force: true,
    });
  }

  private ensureConfig(): Promise<void> {
    if (!this.configReady) {
      this.configReady = (async () => {
        const directory = path.join(this.configDirectory(), "rtk");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(directory, "config.toml"),
          [
            "[tee]",
            "enabled = true",
            'mode = "always"',
            "max_files = 8",
            "max_file_size = 1073741824",
            "",
            "[tracking]",
            "enabled = false",
            "history_days = 0",
            "",
            "[telemetry]",
            "enabled = false",
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
      })();
    }
    return this.configReady;
  }

  private configDirectory(): string {
    return path.join(this.directory, "config");
  }
}

function safeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160) || "tool-call";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
