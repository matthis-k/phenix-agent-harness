/**
 * search tool — content search via ripgrep. Bounded, workspace-safe.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { resolveWorkspacePath } from "./_shared.js";
import { MAX_SEARCH_MATCHES } from "./_shared.js";

interface SearchParams {
  query: string;
  path?: string;
  glob?: string[];
  ignoreCase?: boolean;
  regex?: boolean;
  maxMatches?: number;
  contextLines?: number;
}

export function registerSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search",
    label: "Search",
    description: "Content search using ripgrep. Returns path, line number, preview, and match spans. Bounded at 100 matches.",
    promptSnippet: "Search file contents with ripgrep for structured, bounded results.",
    promptGuidelines: [
      "Use search for content search across files (like grep).",
      "Results are bounded to 100 matches by default.",
      "Use find for path lookup instead of content search.",
      "Use glob to filter by file extension, e.g. ['*.ts', '*.nix']."
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      path: Type.Optional(Type.String({ description: "Search path (defaults to cwd)" })),
      glob: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns (e.g. ['*.ts', '*.nix'])" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat query as regex" })),
      maxMatches: Type.Optional(Type.Number({ description: "Maximum matches (default 100)" })),
      contextLines: Type.Optional(Type.Number({ description: "Lines of context before/after each match" })),
    }),
    async execute(_toolCallId: string, params: SearchParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const searchPath = params.path ? resolveWorkspacePath(cwd, params.path) : cwd;
      const maxMatches = params.maxMatches ?? MAX_SEARCH_MATCHES;

      if (signal?.aborted) throw new Error("cancelled");

      // Check if rg is available
      try {
        await checkRg();
      } catch {
        return {
          content: [{ type: "text", text: "ripgrep (rg) is not available on PATH. Install ripgrep or use a different search approach." }],
          details: { available: false },
        };
      }

      if (signal?.aborted) throw new Error("cancelled");

      const args: string[] = ["--json"];

      if (params.ignoreCase) args.push("-i");
      if (params.regex) args.push("--regexp");
      else args.push("--fixed-strings");

      if (params.glob) {
        for (const g of params.glob) {
          args.push("--glob", g);
        }
      }

      // Exclude common build artifacts
      args.push("--glob", "!.git", "--glob", "!node_modules", "--glob", "!result", "--glob", "!.direnv", "--glob", "!target");

      if (params.contextLines && params.contextLines > 0) {
        args.push("-C", String(params.contextLines));
      }

      args.push(params.query, searchPath);

      const result = await runRg(args, maxMatches);

      if (signal?.aborted) throw new Error("cancelled");

      return {
        content: [{ type: "text", text: formatResults(result, maxMatches) }],
        details: {
          matches: result.matches.length,
          truncated: result.truncated,
          searchPath,
        },
      };
    },
  });
}

interface RgMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface RgResult {
  matches: RgMatch[];
  truncated: boolean;
}

function checkRg(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("rg", ["--version"], { timeout: 5000 }, (err) => {
      if (err) reject(new Error("rg not found"));
      else resolvePromise();
    });
  });
}

function runRg(args: string[], maxMatches: number): Promise<RgResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("rg", args, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("rg not found"));
        return;
      }
      // rg exits with code 1 when no matches; that's not an error for our purposes
      if (err && !("stdout" in err) && stdout === undefined) {
        resolvePromise({ matches: [], truncated: false });
        return;
      }
      if (!stdout) {
        resolvePromise({ matches: [], truncated: false });
        return;
      }

      const matches: RgMatch[] = [];
      let truncated = false;

      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "match") {
            if (matches.length >= maxMatches) {
              truncated = true;
              continue;
            }
            const data = parsed.data;
            const text = data.lines?.text ?? "";
            matches.push({
              path: data.path?.text ?? "",
              line: data.line_number ?? 0,
              column: data.absolute_offset ?? 0,
              text: text.replace(/\n$/, ""),
            });
          }
        } catch {
          // Skip unparseable lines
        }
      }

      resolvePromise({ matches, truncated });
    });
  });
}

function formatResults(result: RgResult, maxMatches: number): string {
  if (result.matches.length === 0) {
    return "No matches found.";
  }

  const lines: string[] = [];
  for (const m of result.matches) {
    lines.push(`${m.path}:${m.line}:${m.text}`);
  }

  if (result.truncated) {
    lines.push(`... (truncated at ${maxMatches} matches)`);
  }

  return lines.join("\n");
}
