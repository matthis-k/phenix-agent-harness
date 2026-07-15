import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  getExecArgs,
  resolveHypaBinary,
} from "@hypabolic/pi-hypa/extensions/rewrite-client.ts";
import { buildReadCommand } from "@hypabolic/pi-hypa/extensions/tools.ts";
import { Type } from "typebox";
import { ensureReadActive, hasHypaReadTool } from "./hypa-read-policy.ts";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function formatFailure(stdout: string, stderr: string, code: number): string {
  const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
  return `Hypa read failed: ${detail}`;
}

export default function registerHypaReadRedirect(pi: ExtensionAPI): void {
  if (!hasHypaReadTool(pi.getAllTools())) return;

  const configuredBinary = process.env.HYPA_BIN?.trim() || "hypa";
  const binary = resolveHypaBinary(configuredBinary);

  pi.registerTool({
    name: "read",
    label: "read",
    description:
      "Read file contents through Hypa compression. Supports offset/limit line slices. " +
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
    promptSnippet: "Read file contents through Hypa compression",
    promptGuidelines: [
      "Use read to inspect files instead of cat or sed; Phenix routes read through Hypa " +
        "when Hypa is available.",
    ],
    parameters: readSchema,
    async execute(_toolCallId, params, signal) {
      const command = buildReadCommand(params.path, params.offset, params.limit);
      const [execBin, execArgs] = getExecArgs(binary, ["-c", command]);
      const result = await pi.exec(execBin, execArgs, { signal });

      if (result.killed) {
        throw new Error("Hypa read was cancelled or timed out.");
      }
      if (result.code !== 0) {
        throw new Error(formatFailure(result.stdout, result.stderr, result.code));
      }

      const combined = [result.stdout, result.stderr]
        .filter((part) => part.length > 0)
        .join(result.stdout && result.stderr ? "\n" : "");
      const truncation = truncateHead(combined);
      const text = truncation.truncated
        ? `${truncation.content}\n\n[Hypa read output truncated at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.]`
        : truncation.content || "(empty file)";

      return {
        content: [{ type: "text" as const, text }],
        details: truncation.truncated ? { truncation } : undefined,
      };
    },
  });

  if ((process.env.HYPA_PI_MODE ?? "additive") === "replace") {
    pi.on("before_agent_start", () => {
      pi.setActiveTools(ensureReadActive(pi.getActiveTools()));
    });
  }
}
