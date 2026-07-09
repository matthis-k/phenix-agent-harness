/**
 * read tool — read files, directories, JSON, and text content with workspace safety.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { resolveWorkspacePath, assertInsideWorkspace, sha256File, truncateText, getFileInfo, MAX_READ_BYTES, MAX_READ_LINES, getState } from "./_shared.js";

interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  format?: "auto" | "text" | "json" | "tree";
}

export function registerRead(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "Read",
    description: "Read project files, directories, JSON, or text content. Resolves relative paths against the working directory. Records file hashes for later edit validation.",
    promptSnippet: "Read files, directories, JSON and text content with line numbers and bounds.",
    promptGuidelines: [
      "Use read for file content, directory listing, JSON pretty-print, markdown, and structured logs.",
      "read records file hashes automatically; later edit calls can use expectedSha256 for stale-anchor checks.",
      "Files outside the workspace are rejected by default.",
      "Large files are truncated at 50KB or 2000 lines."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File or directory path to read" }),
      offset: Type.Optional(Type.Number({ description: "Starting line number (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum lines to return" })),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to read (default 50KB)" })),
      format: Type.Optional(Type.Union([
        Type.Literal("auto"),
        Type.Literal("text"),
        Type.Literal("json"),
        Type.Literal("tree"),
      ], { description: "Output format. auto detects from extension." })),
    }),
    async execute(_toolCallId: string, params: ReadParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const filePath = resolve(cwd, params.path);
      const maxBytes = params.maxBytes ?? MAX_READ_BYTES;
      const format = params.format ?? "auto";

      // Resolve and assert workspace safety
      try {
        resolveWorkspacePath(cwd, params.path);
      } catch {
        // Allow /nix/store paths explicitly
        if (!filePath.startsWith("/nix/store/")) {
          throw new Error(`Path outside workspace: ${params.path}`);
        }
      }

      if (signal?.aborted) throw new Error("cancelled");

      // Detect if path is a directory
      const entryStat = await import("node:fs/promises").then(fs => fs.stat(filePath).catch(() => null));
      if (!entryStat) {
        throw new Error(`Path not found: ${params.path}`);
      }

      if (entryStat.isDirectory()) {
        return handleDirectory(ctx, filePath, format, params);
      }

      // Read file content
      const raw = await readFile(filePath, "utf8");
      const hash = await sha256File(filePath);

      // Store hash for later edit validation
      const state = getState(ctx);
      state.fileHashes[filePath] = hash;
      // Also save by relative path key
      state.fileHashes[params.path] = hash;

      if (signal?.aborted) throw new Error("cancelled");

      // Apply offset/limit
      const lines = raw.split("\n");
      const startLine = params.offset ? Math.max(0, params.offset - 1) : 0;
      const lineLimit = params.limit ?? MAX_READ_LINES;
      const selected = lines.slice(startLine, startLine + lineLimit);
      let content = selected.join("\n");

      // Truncate by bytes if needed
      const truncated = truncateText(content, maxBytes);
      content = truncated.text;

      // Format JSON
      let displayContent = content;
      if (format === "json" || (format === "auto" && [".json", ".jsonc"].includes(extname(filePath).toLowerCase()))) {
        try {
          const parsed = JSON.parse(content);
          displayContent = JSON.stringify(parsed, null, 2);
        } catch {
          // Not valid JSON, show as text
        }
      }

      const lineCount = selected.length;

      return {
        content: [{ type: "text", text: displayContent }],
        details: {
          path: filePath,
          kind: "file",
          bytes: Buffer.byteLength(raw, "utf8"),
          truncated: truncated.truncated,
          sha256: hash,
          lineCount,
          startLine: startLine + 1,
        },
      };
    },
  });
}

async function handleDirectory(ctx: ExtensionContext, dirPath: string, format: string, _params: ReadParams) {
  const entries = await readdir(dirPath, { withFileTypes: true });

  if (format === "tree") {
    // Compact tree
    const lines: string[] = [];
    lines.push(dirPath + "/");
    for (const entry of entries) {
      const suffix = entry.isDirectory() ? "/" : "";
      lines.push(`  ${entry.name}${suffix}`);
    }
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { path: dirPath, kind: "directory", entries: entries.length },
    };
  }

  // Default listing
  const listing = entries.map((e) => ({
    name: e.name,
    kind: e.isDirectory() ? "directory" : "file",
    size: e.isFile() ? null : undefined,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify(listing, null, 2) }],
    details: { path: dirPath, kind: "directory", entries: listing },
  };
}
