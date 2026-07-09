/**
 * edit tool — safe text edits with stale protection and preview/resolve flow.
 *
 * Default mode is "preview". Direct apply requires explicit configuration.
 * Use with resolve tool to apply pending edits.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  resolveWorkspacePath,
  sha256File,
  unifiedDiff,
  getState,
  saveState,
  nextId,
  MAX_EDIT_PREVIEW_LINES,
} from "./_shared.js";
import type { PendingAction } from "./_shared.js";

interface EditParams {
  path: string;
  edits: Array<{
    old: string;
    new: string;
    occurrence?: number;
    expectedSha256?: string;
  }>;
  mode?: "preview" | "apply";
}

export function registerEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: "Safe text edits with stale protection. Preview by default; use resolve to apply pending edits. Requires old text to match exactly once.",
    promptSnippet: "Edit files with preview-first, hash-anchored patching and stale rejection.",
    promptGuidelines: [
      "Use edit for text file modifications with preview-first safety.",
      "Default mode is 'preview' which creates a pending action; use resolve to apply.",
      "Each edits[].old must match exactly once in the current file content.",
      "Provide expectedSha256 for stale-anchor protection against concurrent changes.",
      "Ambiguous or non-unique old text is rejected.",
      "No-op edits (old === new) are reported and do not create actions.",
      "Use resolve accept to apply, resolve reject to discard.",
      "Direct apply mode must be explicitly requested and configured."
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit" }),
      edits: Type.Array(Type.Object({
        old: Type.String({ description: "Exact text to replace (must match exactly once)" }),
        new: Type.String({ description: "Replacement text" }),
        occurrence: Type.Optional(Type.Number({ description: "Occurrence index (1-based) if old text appears multiple times" })),
        expectedSha256: Type.Optional(Type.String({ description: "Expected SHA256 hash of the file for stale protection" })),
      }), { description: "List of edits to apply in order", minItems: 1 }),
      mode: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("apply")], { description: "Preview (default) creates pending action; apply applies directly" })),
    }),
    async execute(_toolCallId: string, params: EditParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = ctx.cwd;
      const filePath = resolveWorkspacePath(cwd, params.path);
      const mode = params.mode ?? "preview";

      if (signal?.aborted) throw new Error("cancelled");

      // Read current file
      const currentContent = await readFile(filePath, "utf8");
      const shaBefore = await sha256File(filePath);

      // Check stale if expectedSha256 provided
      if (params.edits.some(e => e.expectedSha256) && params.edits[0]?.expectedSha256) {
        if (shaBefore !== params.edits[0].expectedSha256) {
          return {
            content: [{ type: "text", text: `STALE: File hash mismatch. Expected ${params.edits[0].expectedSha256}, got ${shaBefore}. File may have been modified since last read.` }],
            details: { status: "rejected", stale: true, shaBefore, shaExpected: params.edits[0].expectedSha256 },
          };
        }
      }

      // Apply each edit sequentially
      let content = currentContent;
      const replacements: Array<{ old: string; new: string; line: number; applied: boolean }> = [];
      let ambiguous = false;
      let stale = false;

      for (const edit of params.edits) {
        const lines = content.split("\n");

        // Find all occurrences
        const indices: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(edit.old)) {
            indices.push(i);
          }
        }

        // Also search across the full content (for multi-line matches)
        let searchFrom = 0;
        const fullIndices: number[] = [];
        while (true) {
          const idx = content.indexOf(edit.old, searchFrom);
          if (idx === -1) break;
          fullIndices.push(idx);
          searchFrom = idx + 1;
        }

        // If no occurrences found via full content, try line-by-line
        const occurrenceIndex = edit.occurrence ? edit.occurrence - 1 : 0;

        if (fullIndices.length === 0) {
          // Check if old is a multi-line match
          if (content.includes(edit.old)) {
            fullIndices.push(content.indexOf(edit.old));
          } else {
            return {
              content: [{ type: "text", text: `NO MATCH: old text not found in ${params.path}.` }],
              details: { status: "rejected", ambiguous: false, stale: false, shaBefore },
            };
          }
        }

        if (fullIndices.length > 1 && !edit.occurrence) {
          // Try exact line match first
          const lineExact = lines.findIndex(l => l.trim() === edit.old.trim());
          if (lineExact >= 0) {
            // Use the line-based match
            const lineIdx = lineExact;
            lines[lineIdx] = edit.new;
            content = lines.join("\n");
            replacements.push({ old: edit.old, new: edit.new, line: lineIdx + 1, applied: true });
            continue;
          }

          ambiguous = true;
          return {
            content: [{ type: "text", text: `AMBIGUOUS: old text appears ${fullIndices.length} times. Use occurrence parameter (1-based) or make old text more specific.` }],
            details: { status: "rejected", ambiguous: true, stale: false, shaBefore, occurrences: fullIndices.length },
          };
        }

        const matchIdx = occurrenceIndex < fullIndices.length ? fullIndices[occurrenceIndex] : -1;
        if (matchIdx === -1) {
          return {
            content: [{ type: "text", text: `NO MATCH: occurrence ${edit.occurrence ?? 1} not found. Only ${fullIndices.length} occurrence(s).` }],
            details: { status: "rejected", ambiguous: false, stale: false, shaBefore },
          };
        }

        // Replace
        const beforeReplace = content;
        content = content.slice(0, matchIdx) + edit.new + content.slice(matchIdx + edit.old.length);

        // Find line number
        const line = beforeReplace.slice(0, matchIdx).split("\n").length;

        if (edit.old === edit.new) {
          return {
            content: [{ type: "text", text: `NO-OP: old and new text are identical in one of the edits.` }],
            details: { status: "rejected", ambiguous: false, stale: false, noop: true, shaBefore },
          };
        }

        replacements.push({ old: edit.old, new: edit.new, line, applied: true });
      }

      // Check for no-op
      if (content === currentContent) {
        return {
          content: [{ type: "text", text: `NO-OP: Edits resulted in no changes to ${params.path}.` }],
          details: { status: "rejected", noop: true, shaBefore },
        };
      }

      if (signal?.aborted) throw new Error("cancelled");

      // Generate diff
      const diff = unifiedDiff(currentContent, content, filePath);

      if (mode === "apply") {
        // Direct apply
        await writeFile(filePath, content, "utf8");
        const shaAfter = await sha256File(filePath);

        // Update state
        const state = getState(ctx);
        state.fileHashes[filePath] = shaAfter;

        return {
          content: [{ type: "text", text: `Applied ${replacements.length} edit(s) to ${params.path}.\n${diff}` }],
          details: {
            status: "applied",
            replacements: replacements.length,
            diff,
            stale: false,
            ambiguous: false,
            shaBefore,
            shaAfter,
          },
        };
      }

      // Preview mode: create pending action
      const actionId = nextId();
      const action: PendingAction = {
        id: actionId,
        kind: "edit",
        createdAt: Date.now(),
        path: filePath,
        description: `${replacements.length} edit(s) to ${params.path}`,
        diff,
        data: {
          path: filePath,
          edits: params.edits.map(e => ({ old: e.old, new: e.new, occurrence: e.occurrence })),
          shaBefore,
          newContent: content,
          oldContent: currentContent,
        },
      };

      const state = getState(ctx);
      state.pendingActions[actionId] = action;
      saveState(ctx);

      return {
        content: [{ type: "text", text: `PREVIEW of ${replacements.length} edit(s) to ${params.path}.\nAction ID: ${actionId}\n\n${diff}\n\nUse resolve accept ${actionId} to apply, or resolve reject ${actionId} to discard.` }],
        details: {
          status: "proposed",
          actionId,
          replacements: replacements.length,
          diff,
          stale: false,
          ambiguous: false,
          shaBefore,
          shaAfterPreview: sha256String(content),
        },
      };
    },
  });
}
