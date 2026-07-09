import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type ServerSpec = {
  command: string;
  args: string[];
  languageId: string;
  extensions: string[];
};

const SERVERS: ServerSpec[] = [
  {
    command: "nil",
    args: [],
    languageId: "nix",
    extensions: [".nix"],
  },
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    languageId: "typescript",
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  {
    command: "rust-analyzer",
    args: [],
    languageId: "rust",
    extensions: [".rs"],
  },
  {
    command: "lua-language-server",
    args: ["--stdio"],
    languageId: "lua",
    extensions: [".lua"],
  },
  {
    command: "taplo",
    args: ["lsp"],
    languageId: "toml",
    extensions: [".toml"],
  },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    languageId: "python",
    extensions: [".py"],
  },
  {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    languageId: "json",
    extensions: [".json", ".jsonc"],
  },
  {
    command: "yaml-language-server",
    args: ["--stdio"],
    languageId: "yaml",
    extensions: [".yaml", ".yml"],
  },
];

type LspResponse = { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };

function serverFor(path: string): ServerSpec | undefined {
  const extension = extname(path);
  return SERVERS.find((server) => server.extensions.includes(extension));
}

function byteOffsetAt(text: string, line: number, character: number): number {
  const lines = text.split(/\r?\n/);
  const prefix = lines.slice(0, Math.max(0, line)).join("\n");
  return Buffer.byteLength(prefix + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, character));
}

async function withServer<T>(
  cwd: string,
  spec: ServerSpec,
  fn: (
    send: (method: string, params?: unknown) => Promise<LspResponse>,
    notify: (method: string, params?: unknown) => void,
    notifications: LspResponse[],
  ) => Promise<T>,
): Promise<T> {
  const child = spawn(spec.command, spec.args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number, (response: LspResponse) => void>();
  const notifications: LspResponse[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const length = /Content-Length: (\d+)/i.exec(header)?.[1];
      if (!length) return;
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length);
      if (buffer.length < bodyEnd) return;
      const message = JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as LspResponse;
      buffer = buffer.subarray(bodyEnd);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
      else notifications.push(message);
    }
  });

  const send = (method: string, params?: unknown) =>
    new Promise<LspResponse>((resolveResponse) => {
      const id = nextId++;
      pending.set(id, resolveResponse);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    });

  const notify = (method: string, params?: unknown) => {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  };

  try {
    await send("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(cwd).toString(),
      capabilities: { textDocument: { hover: {}, publishDiagnostics: {} } },
    });
    notify("initialized", {});
    return await fn(send, notify, notifications);
  } finally {
    child.kill();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Run a read-only language server diagnostics request for supported file types (Nix, TypeScript, JavaScript, Rust, Lua, TOML, Python, JSON, YAML).",
    promptSnippet: "Read-only LSP diagnostics for Nix, TypeScript/JavaScript, Rust, Lua, TOML, Python, JSON, YAML files.",
    promptGuidelines: ["Use lsp_diagnostics only for read-only diagnostics; it never edits files."],
    parameters: Type.Object({ path: Type.String({ description: "File path to inspect" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);
      const spec = serverFor(filePath);
      if (!spec) return { content: [{ type: "text", text: "No configured read-only LSP server for this file extension." }], details: { diagnostics: [] } };
      const text = await readFile(filePath, "utf8");
      if (signal?.aborted) throw new Error("cancelled");
      const uri = pathToFileURL(filePath).toString();
      const diagnostics = await withServer(ctx.cwd, spec, async (_send, notify, notifications) => {
        notify("textDocument/didOpen", { textDocument: { uri, languageId: spec.languageId, version: 1, text } });
        await new Promise((resolve) => setTimeout(resolve, 500));
        return notifications
          .filter((message) => message.method === "textDocument/publishDiagnostics")
          .flatMap((message) => (message.params as { diagnostics?: unknown[] } | undefined)?.diagnostics ?? []);
      });
      return { content: [{ type: "text", text: JSON.stringify(diagnostics, null, 2) }], details: { diagnostics } };
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Run a read-only language server hover request for a supported file type (Nix, TypeScript, JavaScript, Rust, Lua, TOML, Python, JSON, YAML).",
    promptSnippet: "Read-only LSP hover lookup for Nix, TypeScript/JavaScript, Rust, Lua, TOML, Python, JSON, YAML files.",
    promptGuidelines: ["Use lsp_hover only for read-only symbol information; it never edits files."],
    parameters: Type.Object({
      path: Type.String({ description: "File path to inspect" }),
      line: Type.Number({ description: "Zero-based line" }),
      character: Type.Number({ description: "Zero-based UTF-16 character offset" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, params.path);
      const spec = serverFor(filePath);
      if (!spec) return { content: [{ type: "text", text: "No configured read-only LSP server for this file extension." }], details: {} };
      const text = await readFile(filePath, "utf8");
      byteOffsetAt(text, params.line, params.character);
      if (signal?.aborted) throw new Error("cancelled");
      const uri = pathToFileURL(filePath).toString();
      const hover = await withServer(ctx.cwd, spec, async (send, notify) => {
        notify("textDocument/didOpen", { textDocument: { uri, languageId: spec.languageId, version: 1, text } });
        const response = await send("textDocument/hover", { textDocument: { uri }, position: { line: params.line, character: params.character } });
        return response.result ?? null;
      });
      return { content: [{ type: "text", text: JSON.stringify(hover, null, 2) }], details: { hover } };
    },
  });
}
