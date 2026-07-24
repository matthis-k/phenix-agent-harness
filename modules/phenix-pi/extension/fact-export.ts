import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CLIPBOARD_COMMAND = "wl-copy";

export type FactsCommand =
  | { readonly kind: "live" }
  | { readonly kind: "off" }
  | { readonly kind: "once" }
  | { readonly kind: "json" }
  | { readonly kind: "clipboard"; readonly command: string }
  | { readonly kind: "file"; readonly file: string };

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
  const selected = command.trim() || DEFAULT_CLIPBOARD_COMMAND;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", selected], {
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
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, text, "utf8");
  return resolved;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1).trim();
  return value;
}
