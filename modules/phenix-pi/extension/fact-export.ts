import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CLIPBOARD_COMMAND = "wl-copy";

export type FactsCommand =
  | { readonly kind: "live" }
  | { readonly kind: "off" }
  | { readonly kind: "once" }
  | { readonly kind: "json" }
  | { readonly kind: "clipboard"; readonly command: string }
  | { readonly kind: "file"; readonly file: string };

interface ProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export function parseFactsCommand(raw: string): FactsCommand | undefined {
  const value = raw.trim();
  if (!value) return { kind: "live" };
  if (value === "off") return { kind: "off" };
  if (value === "--once") return { kind: "once" };
  if (value === "--json") return { kind: "json" };

  const clipboard = /^--clipboard(?:\s+([\s\S]+))?$/.exec(value);
  if (clipboard) {
    return {
      kind: "clipboard",
      command: clipboard[1]?.trim() || DEFAULT_CLIPBOARD_COMMAND,
    };
  }

  const file = /^--file\s+([\s\S]+)$/.exec(value);
  if (file?.[1]) {
    const selected = stripMatchingQuotes(file[1].trim());
    if (selected) return { kind: "file", file: selected };
  }

  return undefined;
}

export async function copyFactHistory(
  text: string,
  command = DEFAULT_CLIPBOARD_COMMAND,
  cwd = process.cwd(),
): Promise<void> {
  const invocation = parseProcessInvocation(command.trim() || DEFAULT_CLIPBOARD_COMMAND);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code === 0) {
        succeed();
        return;
      }
      const reason = code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      fail(new Error(`Clipboard command failed with ${reason}${detail}`));
    });
    child.stdin?.on("error", fail);
    child.stdin?.end(text);
  });
}

export async function writeFactHistory(text: string, file: string, cwd: string): Promise<string> {
  const selected = file.trim();
  if (!selected) throw new Error("Fact export file path is empty");
  const resolved = path.resolve(cwd, selected);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const handle = await open(resolved, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return resolved;
}

export function parseProcessInvocation(command: string): ProcessInvocation {
  const tokens = tokenizeCommand(command);
  const [executable, ...args] = tokens;
  if (!executable) throw new Error("Clipboard command is empty");
  return { executable, args };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flush = (): void => {
    if (!token) return;
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

  if (escaped) throw new Error("Clipboard command has a trailing escape");
  if (quote) throw new Error("Clipboard command has an unterminated quote");
  flush();
  return tokens;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1).trim();
  return value;
}
