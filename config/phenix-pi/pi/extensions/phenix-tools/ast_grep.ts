/**
 * ast_grep tool — structural code query via ast-grep binary.
 *
 * Shells to ast-grep if available. Fails gracefully if binary is missing.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { resolveWorkspacePath, MAX_AST_MATCHES } from "./_shared.js";

interface AstGrepParams {
  pattern: string;
  language?: string;
  path?: string;
  glob?: string[];
  maxMatches?: number;
  json?: boolean;
}

export function registerAstGrep(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ast_grep",
    label: "AST Grep",
    description: "Structural code query using ast-grep. Query by AST pattern, optionally scoped to language and path. Read-only.",
    promptSnippet: "Structural code search and query using AST patterns.",
    promptGuidelines: [
      "Use ast_grep for structural code queries (e.g. find all function calls matching a pattern).",
      "The pattern syntax follows ast-grep's pattern language.",
      "Optionally specify a language (e.g. nix, typescript) to scope the query.",
      "Results are read-only; use ast_edit for structural rewrites.",
      "Fails gracefully if ast-grep binary is not available."
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "AST pattern to search for (ast-grep pattern syntax)" }),
      language: Type.Optional(Type.String({ description: "Language to scope the query (e.g. nix, typescript)" })),
      path: Type.Optional(Type.String({ description: "Search root path (defaults to cwd)" })),
      glob: Type.Optional(Type.Array(Type.String(), { description: "Glob patterns to filter files" })),
      maxMatches: Type.Optional(Type.Number({ description: "Maximum matches (default 50)" })),
      json: Type.Optional(Type.Boolean({ description: "Output raw JSON (default true)" })),
    }),
    async execute(_toolCallId: string, params: AstGrepParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const searchPath = params.path ? resolveWorkspacePath(cwd, params.path) : cwd;
      const maxMatches = params.maxMatches ?? MAX_AST_MATCHES;

      if (signal?.aborted) throw new Error("cancelled");

      // Check if ast-grep is available
      try {
        await checkAstGrep();
      } catch {
        return {
          content: [{ type: "text", text: "ast-grep binary is not available on PATH. Install ast-grep or use search (ripgrep) as a fallback." }],
          details: { available: false },
        };
      }

      if (signal?.aborted) throw new Error("cancelled");

      const args: string[] = ["--pattern", params.pattern];

      if (params.language) args.push("--lang", params.language);
      if (params.glob) {
        for (const g of params.glob) {
          args.push("--glob", g);
        }
      }

      // Always request JSON output
      args.push("--json");

      args.push(searchPath);

      const result = await runAstGrep(args, maxMatches);

      if (signal?.aborted) throw new Error("cancelled");

      return {
        content: [{ type: "text", text: formatResult(result, maxMatches) }],
        details: {
          matches: result.matches,
          truncated: result.truncated,
          available: true,
          searchPath,
        },
      };
    },
  });
}

interface AstGrepResult {
  matches: string[];
  truncated: boolean;
}

function checkAstGrep(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("ast-grep", ["--version"], { timeout: 5000 }, (err) => {
      if (err) reject(new Error("ast-grep not found"));
      else resolvePromise();
    });
  });
}

function runAstGrep(args: string[], maxMatches: number): Promise<AstGrepResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("ast-grep", args, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ast-grep not found"));
        return;
      }
      if (!stdout) {
        resolvePromise({ matches: [], truncated: false });
        return;
      }

      const allMatches = stdout.trim().split("\n").filter(Boolean);
      const matches = allMatches.slice(0, maxMatches);

      resolvePromise({
        matches,
        truncated: allMatches.length > maxMatches,
      });
    });
  });
}

function formatResult(result: AstGrepResult, maxMatches: number): string {
  if (result.matches.length === 0) {
    return "No AST matches found.";
  }

  const lines: string[] = [];
  for (const match of result.matches) {
    try {
      const parsed = JSON.parse(match);
      const file = parsed.file ?? parsed.path ?? "?";
      const pos = parsed.position ?? parsed.range ?? parsed.line ?? "";
      const text = parsed.text ?? parsed.content ?? "";
      lines.push(`${file}:${pos}:${typeof text === "string" ? text.trim() : JSON.stringify(text)}`);
    } catch {
      lines.push(match);
    }
  }

  if (result.truncated) {
    lines.push(`... (truncated at ${maxMatches} matches)`);
  }

  return lines.join("\n");
}
