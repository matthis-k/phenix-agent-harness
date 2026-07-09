/**
 * lsp tool — unified LSP operations: diagnostics, hover, definition, references, document_symbols.
 *
 * Read-only only. Defers write operations (rename, code_action, workspace/applyEdit).
 * Supports: Nix (nil), TypeScript/JavaScript (typescript-language-server),
 * Rust (rust-analyzer), Lua (lua-language-server), TOML (taplo),
 * Python (pyright-langserver), JSON/JSONC (vscode-json-language-server),
 * YAML (yaml-language-server).
 *
 * This is the unified tool; the existing lsp.ts extension (lsp_diagnostics, lsp_hover)
 * remains available for backward compatibility.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkspacePath, LSP_TIMEOUT_MS } from "./_shared.js";

type LspOp = "diagnostics" | "hover" | "definition" | "references" | "document_symbols";

interface LspParams {
  op: LspOp;
  path: string;
  line?: number;
  character?: number;
  timeoutMs?: number;
}

type ServerSpec = {
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
};

const SERVERS: ServerSpec[] = [
  { command: "nil", args: [], languageId: "nix", extensions: [".nix"] },
  { command: "typescript-language-server", args: ["--stdio"], languageId: "typescript", extensions: [".ts", ".tsx", ".js", ".jsx"] },
  { command: "rust-analyzer", args: [], languageId: "rust", extensions: [".rs"] },
  { command: "lua-language-server", args: ["--stdio"], languageId: "lua", extensions: [".lua"] },
  { command: "taplo", args: ["lsp"], languageId: "toml", extensions: [".toml"] },
  { command: "pyright-langserver", args: ["--stdio"], languageId: "python", extensions: [".py"] },
  { command: "vscode-json-language-server", args: ["--stdio"], languageId: "json", extensions: [".json", ".jsonc"] },
  { command: "yaml-language-server", args: ["--stdio"], languageId: "yaml", extensions: [".yaml", ".yml"] },
];

function serverFor(path: string): ServerSpec | undefined {
  const extension = extname(path);
  return SERVERS.find((s) => s.extensions.includes(extension));
}

type LspResponse = { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };

async function withServer<T>(
  cwd: string,
  spec: ServerSpec,
  fn: (send: (method: string, params?: unknown) => Promise<LspResponse>, notify: (method: string, params?: unknown) => void, notifications: LspResponse[]) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(spec.command, spec.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    const pending = new Map<number, (response: LspResponse) => void>();
    const notifications: LspResponse[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(new Error(`LSP request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const lengthMatch = /Content-Length: (\d+)/i.exec(header);
        if (!lengthMatch) return;
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(lengthMatch[1]);
        if (buffer.length < bodyEnd) return;
        const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as LspResponse;
        buffer = buffer.subarray(bodyEnd);
        if (typeof message.id === "number") {
          pending.get(message.id)?.(message);
        } else {
          notifications.push(message);
        }
      }
    });

    child.stderr.on("data", () => {
      // Drain stderr silently
    });

    const send = (method: string, params?: unknown) =>
      new Promise<LspResponse>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      });

    const notify = (method: string, params?: unknown) => {
      const body = JSON.stringify({ jsonrpc: "2.0", method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    };

    const cleanup = () => {
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 1000).unref();
    };

    send("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).toString(),
      capabilities: {
        textDocument: {
          hover: {},
          definition: {},
          references: {},
          documentSymbol: {},
          publishDiagnostics: {},
        },
      },
    })
      .then(() => {
        notify("initialized", {});
        return fn(send, notify, notifications);
      })
      .then((result) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolvePromise(result);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          rejectPromise(err);
        }
      });
  });
}

export function registerLsp(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "IDE-grade code intelligence: diagnostics, hover, definition, references, document_symbols. Read-only; no write LSP operations exposed.",
    promptSnippet: "Code intelligence via LSP: diagnostics, hover, go-to-definition, references, document symbols.",
    promptGuidelines: [
      "Use lsp for code intelligence: diagnostics, hover info, go-to-definition, find references, document symbols.",
      "Requires language server (nil for Nix, typescript-language-server for TS/JS, rust-analyzer for Rust, etc.).",
      "Read-only operation. For edits, use edit + resolve.",
      "line/character are zero-based."
    ],
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("diagnostics"),
        Type.Literal("hover"),
        Type.Literal("definition"),
        Type.Literal("references"),
        Type.Literal("document_symbols"),
      ], { description: "LSP operation" }),
      path: Type.String({ description: "File path" }),
      line: Type.Optional(Type.Number({ description: "Zero-based line (required for hover/definition/references)" })),
      character: Type.Optional(Type.Number({ description: "Zero-based character offset (required for hover/definition/references)" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default 15000)" })),
    }),
    async execute(_toolCallId: string, params: LspParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const filePath = resolveWorkspacePath(cwd, params.path);
      const timeoutMs = params.timeoutMs ?? LSP_TIMEOUT_MS;

      if (signal?.aborted) throw new Error("cancelled");

      const spec = serverFor(filePath);
      if (!spec) {
        return {
          content: [{ type: "text", text: `No configured LSP server for file extension: ${extname(filePath)}. Supported: ${SERVERS.map((s) => s.extensions.join(", ")).join("; ")}` }],
          details: {},
        };
      }

      if (signal?.aborted) throw new Error("cancelled");

      const text = await readFile(filePath, "utf8");
      const uri = pathToFileURL(filePath).toString();

      if (signal?.aborted) throw new Error("cancelled");

      const result = await withServer(cwd, spec, async (send, notify, notifications) => {
        notify("textDocument/didOpen", {
          textDocument: { uri, languageId: spec.languageId, version: 1, text },
        });

        // Wait a short time for diagnostics to arrive
        if (params.op === "diagnostics") {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return notifications
            .filter((msg) => msg.method === "textDocument/publishDiagnostics")
            .flatMap((msg) => (msg.params as { diagnostics?: unknown[] })?.diagnostics ?? []);
        }

        // Position-based operations
        const position = { line: params.line ?? 0, character: params.character ?? 0 };

        switch (params.op) {
          case "hover": {
            const response = await send("textDocument/hover", { textDocument: { uri }, position });
            return response.result ?? null;
          }
          case "definition": {
            const response = await send("textDocument/definition", { textDocument: { uri }, position });
            return response.result ?? null;
          }
          case "references": {
            const response = await send("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } });
            return response.result ?? null;
          }
          case "document_symbols": {
            const response = await send("textDocument/documentSymbol", { textDocument: { uri } });
            return response.result ?? null;
          }
          default:
            return null;
        }
      }, timeoutMs);

      if (signal?.aborted) throw new Error("cancelled");

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { operation: params.op, result },
      };
    },
  });
}
