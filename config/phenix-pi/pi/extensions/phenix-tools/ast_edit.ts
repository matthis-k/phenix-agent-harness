/**
 * ast_edit tool — structural rewrite with preview/resolve flow.
 *
 * Preview by default. Creates pending action; use resolve to apply.
 * Direct apply is not supported; always goes through preview/resolve.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkspacePath, sha256File, generateDiff, getState, saveState, nextId } from "./_shared.js";
import type { PendingAction } from "./_shared.js";

interface AstEditParams {
  path: string;
  language?: string;
  pattern: string;
  rewrite: string;
  mode?: "preview" | "apply";
}

export function registerAstEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    description: "Structural rewrite using ast-grep with preview/resolve safety. Preview by default; use resolve to apply. Direct apply not supported.",
    promptSnippet: "Structural code rewrite with AST-pattern matching and preview-first safety.",
    promptGuidelines: [
      "Use ast_edit for structural rewrites with AST-pattern matching.",
      "Always previews first; creates a pending action for resolve.",
      "The pattern matches existing code structure, rewrite is the replacement.",
      "Rejects if no matches or too many matches (safety bound).",
      "Use ast_grep for read-only structural search."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit" }),
      language: Type.Optional(Type.String({ description: "Language (e.g. nix, typescript). Default: auto-detect from extension." })),
      pattern: Type.String({ description: "AST pattern to match (ast-grep pattern syntax)" }),
      rewrite: Type.String({ description: "Replacement AST pattern" }),
      mode: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("apply")], { description: "Preview (default) creates pending action; apply applies directly" })),
    }),
    async execute(_toolCallId: string, params: AstEditParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const filePath = resolveWorkspacePath(cwd, params.path);
      const mode = params.mode ?? "preview";

      if (signal?.aborted) throw new Error("cancelled");

      // Check if ast-grep is available
      try {
        execFileSync("ast-grep", ["--version"], { timeout: 5000 });
      } catch {
        return {
          content: [{ type: "text", text: "ast-grep binary is not available on PATH. Install ast-grep to use AST operations." }],
          details: { available: false },
        };
      }

      if (signal?.aborted) throw new Error("cancelled");

      const currentContent = await readFile(filePath, "utf8");
      const shaBefore = await sha256File(filePath);

      // Run ast-grep in rewrite mode to a temp file
      const tmpDir = await mkdtemp(resolve(tmpdir(), "phenix-ast-edit-"));
      const tmpOut = resolve(tmpDir, "output");

      try {
        const args: string[] = [
          "rewrite",
          "--pattern", params.pattern,
          "--rewrite", params.rewrite,
        ];

        if (params.language) args.push("--lang", params.language);

        // Write to temp output
        args.push("--stdout");

        // Process
        const result = execFileSync("ast-grep", args, {
          cwd: cwd,
          input: currentContent,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 15_000,
        });

        if (!result || result.trim() === currentContent.trim()) {
          await rm(tmpDir, { recursive: true, force: true });
          return {
            content: [{ type: "text", text: `No AST matches found for pattern: ${params.pattern}` }],
            details: { status: "no_match", shaBefore },
          };
        }

        if (signal?.aborted) throw new Error("cancelled");

        const newContent = result;
        const diff = generateDiff(currentContent, newContent, filePath);

        if (mode === "apply") {
          await writeFile(filePath, newContent, "utf8");
          const shaAfter = await sha256File(filePath);

          const state = getState(ctx);
          state.fileHashes[filePath] = shaAfter;

          await rm(tmpDir, { recursive: true, force: true });

          return {
            content: [{ type: "text", text: `Applied AST rewrite to ${params.path}.\n${diff}` }],
            details: { status: "applied", diff, shaBefore, shaAfter },
          };
        }

        // Preview: create pending action
        const actionId = nextId();
        const action: PendingAction = {
          id: actionId,
          kind: "ast_edit",
          createdAt: Date.now(),
          path: filePath,
          description: `AST rewrite of ${params.path}: ${params.pattern} -> ${params.rewrite}`,
          diff,
          data: {
            path: filePath,
            pattern: params.pattern,
            rewrite: params.rewrite,
            language: params.language,
            shaBefore,
            newContent,
            oldContent: currentContent,
          },
        };

        const state = getState(ctx);
        state.pendingActions[actionId] = action;
        saveState(ctx);

        await rm(tmpDir, { recursive: true, force: true });

        return {
          content: [{ type: "text", text: `PREVIEW of AST rewrite for ${params.path}.\nAction ID: ${actionId}\n\n${diff}\n\nUse resolve accept ${actionId} to apply, or resolve reject ${actionId} to discard.` }],
          details: { status: "proposed", actionId, diff, shaBefore, shaAfterPreview: sha256String(newContent) },
        };
      } catch (err) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    },
  });
}
