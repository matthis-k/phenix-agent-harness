import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerMemoryHooks } from "../adapters/pi-sdk/memory-session-extension.ts";
import { evidenceId, type MemoryNote } from "../domain/memory/model.ts";
import { MemoryInspector } from "./memory-inspector.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";
import {
  WorkspaceSelectDialog,
  type WorkspaceSelectDialogItem,
} from "./workspace/workspace-select-dialog.ts";

export default function registerMemoryExtension(pi: ExtensionAPI): void {
  let binding: WorkspaceRuntimeBinding | undefined;

  subscribeWorkspaceRuntime(pi.events, (next) => {
    binding = next;
  });

  registerMemoryHooks(pi, () =>
    binding
      ? {
          memory: binding.runtime.memory,
          runId: binding.rootRunId,
        }
      : undefined,
  );

  pi.registerCommand("memory", {
    description: "Browse Phenix memory or inspect exact evidence",
    handler: async (args, ctx) => {
      const active = binding;
      if (!active) {
        ctx.ui.notify("Phenix memory is not initialized.", "warning");
        return;
      }
      const request = args.trim();
      if (request.startsWith("read ")) {
        const id = request.slice("read ".length).trim();
        if (!id) {
          ctx.ui.notify("Usage: /memory read <evidence-id>", "warning");
          return;
        }
        const result = await active.runtime.memory.read(active.rootRunId, evidenceId(id));
        await openMemoryDetail(
          ctx,
          `Evidence ${id}`,
          formatEvidence(result.evidence, result.content),
        );
        return;
      }

      const notes = await active.runtime.memory.search({
        runId: active.rootRunId,
        ...(request ? { query: request } : {}),
        limit: 100,
      });
      if (notes.length === 0) {
        ctx.ui.notify(
          request ? `No memory matched “${request}”.` : "No Phenix memory recorded yet.",
          "info",
        );
        return;
      }
      const selected = await selectMemoryNote(ctx, notes);
      if (!selected) return;
      const detail = await formatMemoryNote(active, selected);
      await openMemoryDetail(ctx, `${selected.kind}: ${selected.summary}`, detail);
    },
  });

  pi.on("session_shutdown", () => {
    binding = undefined;
  });
}

async function selectMemoryNote(
  ctx: ExtensionContext,
  notes: readonly MemoryNote[],
): Promise<MemoryNote | undefined> {
  const items: WorkspaceSelectDialogItem<MemoryNote>[] = notes.map((note) => ({
    id: note.id,
    label: note.summary,
    detail: `${note.kind} · ${note.status} · ${note.reliability}`,
    searchText: `${note.kind} ${note.status} ${note.subject ?? ""} ${note.summary}`,
    value: note,
  }));
  return ctx.ui.custom<MemoryNote | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceSelectDialog({
        tui,
        theme: theme as unknown as ObservabilityTheme,
        keybindings,
        title: "Phenix Memory",
        items,
        emptyMessage: "No matching memory",
        maxVisible: 16,
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "82%",
        maxHeight: "82%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function formatMemoryNote(
  binding: WorkspaceRuntimeBinding,
  note: MemoryNote,
): Promise<string> {
  const lines = [
    `ID: ${note.id}`,
    `Kind: ${note.kind}`,
    `Status: ${note.status}`,
    `Reliability: ${note.reliability}`,
    `Retention: ${note.retention}`,
    `Run: ${note.runId}`,
    `Objectives: ${note.objectiveIds.join(", ") || "none"}`,
    `Subject: ${note.subject ?? "none"}`,
    `Created: ${note.createdAt}`,
    `Updated: ${note.updatedAt}`,
    "",
    note.summary,
  ];
  if (note.supersedes?.length) {
    lines.push("", `Supersedes: ${note.supersedes.join(", ")}`);
  }
  if (note.invalidatedBy) lines.push("", `Invalidated by: ${note.invalidatedBy}`);
  if (note.evidenceIds.length === 0) return lines.join("\n");

  lines.push("", "Evidence:");
  let remaining = 60_000;
  for (const id of note.evidenceIds) {
    try {
      const result = await binding.runtime.memory.read(binding.rootRunId, id);
      const content = result.content.slice(0, Math.min(remaining, 20_000));
      remaining -= content.length;
      lines.push("", formatEvidence(result.evidence, content));
      if (content.length < result.content.length) {
        lines.push(
          `[Evidence truncated in UI: ${content.length}/${result.content.length} characters]`,
        );
      }
      if (remaining <= 0) {
        lines.push("", "[Additional evidence omitted from the UI budget]");
        break;
      }
    } catch (error) {
      lines.push("", `${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines.join("\n");
}

function formatEvidence(
  evidence: Awaited<
    ReturnType<WorkspaceRuntimeBinding["runtime"]["memory"]["read"]>
  >["evidence"],
  content: string,
): string {
  return [
    `--- ${evidence.id} ---`,
    `Source: ${evidence.source.kind}`,
    `Hash: ${evidence.contentHash}`,
    `Media type: ${evidence.mediaType}`,
    `Size: ${evidence.sizeBytes} bytes`,
    `Created: ${evidence.createdAt}`,
    "",
    content,
  ].join("\n");
}

async function openMemoryDetail(
  ctx: ExtensionContext,
  title: string,
  content: string,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new MemoryInspector({
        tui,
        theme: theme as unknown as ObservabilityTheme,
        keybindings,
        title,
        content,
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        maxHeight: "92%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}
