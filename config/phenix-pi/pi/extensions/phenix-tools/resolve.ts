/**
 * resolve tool — apply/discard pending preview actions.
 *
 * Central gate for edit, ast_edit, and future pending actions.
 * Only tool that can apply previewed edits by default.
 * Re-validates stale hashes before applying.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { getState, saveState, sha256File } from "./_shared.js";

interface ResolveParams {
  actionId?: string;
  decision: "accept" | "reject" | "list" | "show";
  reason?: string;
}

export function registerResolve(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "resolve",
    label: "Resolve",
    description: "Apply or discard pending preview actions (edit, ast_edit, and future actions). Only tool that can apply previewed edits by default. Re-validates stale hashes before applying.",
    promptSnippet: "Accept or reject pending preview actions. Only tool that applies previewed mutations.",
    promptGuidelines: [
      "Use resolve to apply or discard pending actions from edit or ast_edit.",
      "resolve accept <actionId> — applies the previewed change if file is not stale.",
      "resolve reject <actionId> — discards the pending action.",
      "resolve list — shows all pending actions.",
      "resolve show <actionId> — shows details/diff of a pending action.",
      "resolve re-validates file hashes before applying; stale files are rejected.",
      "This is the ONLY tool that applies previewed mutations."
    ],
    parameters: Type.Object({
      decision: Type.Union([
        Type.Literal("accept"),
        Type.Literal("reject"),
        Type.Literal("list"),
        Type.Literal("show"),
      ], { description: "Decision" }),
      actionId: Type.Optional(Type.String({ description: "Action ID to accept/reject/show" })),
      reason: Type.Optional(Type.String({ description: "Reason for accept or reject" })),
    }),
    async execute(_toolCallId: string, params: ResolveParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("cancelled");

      const state = getState(ctx);
      const actions = state.pendingActions;

      switch (params.decision) {
        case "list": {
          const entries = Object.values(actions);
          if (entries.length === 0) {
            return { content: [{ type: "text", text: "No pending actions." }], details: { actions: [] } };
          }

          const lines = entries.map((a) => {
            const age = Math.round((Date.now() - a.createdAt) / 1000);
            return `${a.id}: [${a.kind}] ${a.description} (${age}s ago)`;
          });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { actions: entries },
          };
        }

        case "show": {
          if (!params.actionId) {
            return { content: [{ type: "text", text: "actionId is required for show." }], details: {} };
          }

          const action = actions[params.actionId];
          if (!action) {
            return { content: [{ type: "text", text: `Action not found: ${params.actionId}` }], details: {} };
          }

          const parts: string[] = [
            `Action: ${action.id}`,
            `Kind: ${action.kind}`,
            `Description: ${action.description}`,
            `Created: ${new Date(action.createdAt).toISOString()}`,
          ];
          if (action.path) parts.push(`Path: ${action.path}`);
          if (action.diff) parts.push(`\nDiff:\n${action.diff}`);
          if (action.data.shaBefore) parts.push(`\nSHA before: ${action.data.shaBefore}`);

          return {
            content: [{ type: "text", text: parts.join("\n") }],
            details: { action },
          };
        }

        case "accept": {
          if (!params.actionId) {
            return { content: [{ type: "text", text: "actionId is required for accept." }], details: {} };
          }

          const action = actions[params.actionId];
          if (!action) {
            return { content: [{ type: "text", text: `Action not found: ${params.actionId}` }], details: {} };
          }

          // Apply based on kind
          switch (action.kind) {
            case "edit": {
              const filePath = action.data.path;
              if (!filePath) {
                return { content: [{ type: "text", text: "Action has no file path." }], details: {} };
              }

              // Re-validate stale hash
              const currentSha = await sha256File(filePath).catch(() => "");
              const expectedSha = action.data.shaBefore;
              if (expectedSha && currentSha !== expectedSha) {
                return {
                  content: [{ type: "text", text: `STALE: File ${filePath} has changed since preview. Expected hash ${expectedSha}, got ${currentSha}. Rejecting to prevent corruption.` }],
                  details: { status: "rejected", stale: true, currentSha, expectedSha },
                };
              }

              // Apply the new content
              const newContent = action.data.newContent as string;
              if (!newContent) {
                return { content: [{ type: "text", text: "Action has no new content data." }], details: {} };
              }

              await writeFile(filePath, newContent, "utf8");
              const shaAfter = await sha256File(filePath).catch(() => "");

              // Update file hash in state
              state.fileHashes[filePath] = shaAfter;

              // Remove the action
              delete state.pendingActions[params.actionId];
              saveState(ctx);

              return {
                content: [{ type: "text", text: `Applied action ${params.actionId}: ${action.description}` }],
                details: { status: "applied", path: filePath, shaAfter, action },
              };
            }

            case "ast_edit": {
              const filePath = action.data.path;
              if (!filePath) {
                return { content: [{ type: "text", text: "Action has no file path." }], details: {} };
              }

              // Re-validate stale hash
              const currentSha = await sha256File(filePath).catch(() => "");
              const expectedSha = action.data.shaBefore;
              if (expectedSha && currentSha !== expectedSha) {
                return {
                  content: [{ type: "text", text: `STALE: File ${filePath} has changed since preview. Rejecting.` }],
                  details: { status: "rejected", stale: true, currentSha, expectedSha },
                };
              }

              const newContent = action.data.newContent as string;
              if (!newContent) {
                return { content: [{ type: "text", text: "Action has no new content data." }], details: {} };
              }

              await writeFile(filePath, newContent, "utf8");
              const shaAfter = await sha256File(filePath).catch(() => "");

              state.fileHashes[filePath] = shaAfter;
              delete state.pendingActions[params.actionId];
              saveState(ctx);

              return {
                content: [{ type: "text", text: `Applied AST edit action ${params.actionId}: ${action.description}` }],
                details: { status: "applied", path: filePath, shaAfter, action },
              };
            }

            default: {
              // Generic apply: try data.path and data.newContent
              const filePath = action.data.path as string | undefined;
              const newContent = action.data.newContent as string | undefined;
              if (filePath && newContent) {
                await writeFile(filePath, newContent, "utf8");
                delete state.pendingActions[params.actionId];
                saveState(ctx);
                return {
                  content: [{ type: "text", text: `Applied action ${params.actionId}: ${action.description}` }],
                  details: { status: "applied", path: filePath },
                };
              }

              return {
                content: [{ type: "text", text: `Cannot apply action of kind ${action.kind}: no apply logic.` }],
                details: { status: "error", action },
              };
            }
          }
        }

        case "reject": {
          if (!params.actionId) {
            return { content: [{ type: "text", text: "actionId is required for reject." }], details: {} };
          }

          const action = actions[params.actionId];
          if (!action) {
            return { content: [{ type: "text", text: `Action not found: ${params.actionId}` }], details: {} };
          }

          delete state.pendingActions[params.actionId];
          saveState(ctx);

          return {
            content: [{ type: "text", text: `Rejected action ${params.actionId}: ${action.description}${params.reason ? ` (reason: ${params.reason})` : ""}` }],
            details: { status: "rejected", action },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown decision: ${params.decision}` }], details: {} };
      }
    },
  });
}
