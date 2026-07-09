/**
 * find tool — path lookup via fd. Bounded, workspace-safe, excludes build artifacts by default.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { resolveWorkspacePath } from "./_shared.js";
import { MAX_FIND_RESULTS } from "./_shared.js";

interface FindParams {
  pattern: string;
  path?: string;
  type?: "file" | "dir" | "any";
  glob?: boolean;
  maxResults?: number;
}

export function registerFind(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "find",
    label: "Find",
    description: "Path lookup using fd. Finds files and directories by name pattern. Excludes .git, node_modules, result, .direnv, target by default.",
    promptSnippet: "Find files and directories by name pattern with ranked results.",
    promptGuidelines: [
      "Use find for path lookup (file/directory names), not content search.",
      "Use search for content search instead.",
      "Results exclude build artifacts (.git, node_modules, result, .direnv, target).",
      "Results are bounded at 100 entries.",
      "Set glob=true to treat pattern as a glob (e.g. '*.nix')."
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "Filename pattern to search for" }),
      path: Type.Optional(Type.String({ description: "Search root path (defaults to cwd)" })),
      type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("any")], { description: "Filter by type" })),
      glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob (e.g. '*.nix')" })),
      maxResults: Type.Optional(Type.Number({ description: "Maximum results (default 100)" })),
    }),
    async execute(_toolCallId: string, params: FindParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const searchPath = params.path ? resolveWorkspacePath(cwd, params.path) : cwd;
      const maxResults = params.maxResults ?? MAX_FIND_RESULTS;

      if (signal?.aborted) throw new Error("cancelled");

      // Check if fd is available
      try {
        await checkFd();
      } catch {
        // Fall back to find-based implementation
        return fallbackFind(ctx, params, searchPath, maxResults, signal);
      }

      if (signal?.aborted) throw new Error("cancelled");

      const args: string[] = [];

      if (params.type && params.type !== "any") {
        args.push("--type", params.type);
      }

      if (params.glob) {
        args.push("--glob", params.pattern);
      } else {
        args.push(params.pattern);
      }

      args.push(searchPath);

      const result = await runFd(args, maxResults);

      if (signal?.aborted) throw new Error("cancelled");

      return {
        content: [{ type: "text", text: formatResults(result, maxResults) }],
        details: {
          matches: result.matches.length,
          truncated: result.truncated,
          searchPath,
        },
      };
    },
  });
}

interface FdResult {
  matches: string[];
  truncated: boolean;
}

function checkFd(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("fd", ["--version"], { timeout: 5000 }, (err) => {
      if (err) reject(new Error("fd not found"));
      else resolvePromise();
    });
  });
}

function runFd(args: string[], maxResults: number): Promise<FdResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("fd", args, { maxBuffer: 1024 * 1024, timeout: 15_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("fd not found"));
        return;
      }
      // fd exits with code 1 for no matches
      if (!stdout) {
        resolvePromise({ matches: [], truncated: false });
        return;
      }

      const allMatches = stdout.trim().split("\n").filter(Boolean);
      const matches = allMatches.slice(0, maxResults);

      resolvePromise({
        matches,
        truncated: allMatches.length > maxResults,
      });
    });
  });
}

async function fallbackFind(_ctx: ExtensionContext, params: FindParams, searchPath: string, maxResults: number, signal?: AbortSignal): Promise<unknown> {
  // Use Node.js recursive walk as fallback
  const { readdir } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");

  const matches: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;
    if (signal?.aborted) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        if (signal?.aborted) return;

        // Skip build artifacts
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "result" || entry.name === ".direnv" || entry.name === "target") continue;

        const fullPath = join(dir, entry.name);

        // Check type filter
        if (params.type === "file" && entry.isDirectory()) continue;
        if (params.type === "dir" && !entry.isDirectory()) continue;

        // Check pattern match
        const name = entry.name;
        if (params.glob) {
          // Simple glob matching
          const globPattern = params.pattern.replace(/\*/g, ".*");
          if (new RegExp(`^${globPattern}$`).test(name)) {
            matches.push(fullPath);
          }
        } else {
          // Simple substring match with ranking
          if (name === params.pattern) {
            matches.unshift(fullPath); // exact match first
          } else if (name.startsWith(params.pattern)) {
            matches.splice(Math.min(1, matches.length), 0, fullPath); // prefix match second
          } else if (name.includes(params.pattern)) {
            matches.push(fullPath); // substring match
          }
        }

        // Recurse into directories
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          await walk(fullPath);
        }
      }
    } catch {
      // Permission denied or other error, skip
    }
  }

  await walk(searchPath);

  return {
    content: [{ type: "text", text: matches.slice(0, maxResults).join("\n") || "No matches found." }],
    details: { matches: matches.length, truncated: matches.length > maxResults, searchPath },
  };
}

function formatResults(result: FdResult, maxResults: number): string {
  if (result.matches.length === 0) {
    return "No matches found.";
  }
  const lines = result.matches.map((p) => p);
  if (result.truncated) {
    lines.push(`... (truncated at ${maxResults} results)`);
  }
  return lines.join("\n");
}
