import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerMemoryHooks } from "../adapters/pi-sdk/memory-session-extension.ts";
import {
  evidenceId,
  type MemoryHealthSnapshot,
  type MemoryIntegrityIssue,
  type MemoryNote,
  type MemorySnapshot,
  memoryNoteId,
} from "../domain/memory/model.ts";
import { MEMORY_COMMAND_USAGE, parseMemoryCommand } from "./memory-command.ts";
import { MemoryInspector } from "./memory-inspector.ts";
import type { ObservabilityTheme } from "./observability-theme.ts";
import {
  WorkspaceSelectDialog,
  type WorkspaceSelectDialogItem,
} from "./workspace/workspace-select-dialog.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

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
    description: "Browse, verify, repair, and maintain Phenix memory",
    handler: async (args, ctx) => {
      const active = binding;
      if (!active) {
        ctx.ui.notify("Phenix memory is not initialized.", "warning");
        return;
      }

      try {
        const command = parseMemoryCommand(args);
        switch (command.kind) {
          case "help":
            await openMemoryDetail(ctx, "Phenix Memory", MEMORY_COMMAND_USAGE);
            return;
          case "health": {
            const health = await active.runtime.memory.health(
              active.rootRunId,
              command.verifyEvidence,
            );
            await openMemoryDetail(
              ctx,
              command.verifyEvidence
                ? `Memory verification: ${health.state}`
                : `Memory health: ${health.state}`,
              formatMemoryHealth(health),
            );
            return;
          }
          case "snapshot": {
            const snapshot = await active.runtime.memory.snapshot(active.rootRunId);
            await openMemoryDetail(
              ctx,
              `Memory snapshot: ${snapshot.health.state}`,
              formatMemorySnapshot(snapshot),
            );
            return;
          }
          case "policy":
            await openMemoryDetail(
              ctx,
              "Memory policy",
              JSON.stringify(active.runtime.memory.policy, undefined, 2),
            );
            return;
          case "repair": {
            const result = await active.runtime.memory.repair(active.rootRunId);
            const level =
              result.remainingIssues.length > 0 ? "warning" : result.repaired ? "info" : "info";
            ctx.ui.notify(
              result.repaired
                ? `Memory ledger repaired; removed ${result.removedLedgerBytes} trailing bytes.`
                : "Memory ledger did not require a recoverable-tail repair.",
              level,
            );
            if (result.remainingIssues.length > 0) {
              await openMemoryDetail(
                ctx,
                "Memory repair issues",
                result.remainingIssues.map(formatMemoryIssue).join("\n"),
              );
            }
            return;
          }
          case "maintain": {
            const result = await active.runtime.memory.maintain(active.rootRunId);
            ctx.ui.notify(
              `Memory maintenance removed ${result.removedNoteCount} notes and ${result.removedEvidenceCount} evidence records; reclaimed ${result.reclaimedEvidenceBytes} bytes.`,
              "info",
            );
            await openMemoryDetail(
              ctx,
              "Memory maintenance",
              JSON.stringify(result, undefined, 2),
            );
            return;
          }
          case "set-status": {
            const note = await active.runtime.memory.setStatus(
              active.rootRunId,
              memoryNoteId(command.noteId),
              command.status,
              command.status === "invalidated" && command.invalidatedBy !== undefined
                ? memoryNoteId(command.invalidatedBy)
                : undefined,
            );
            ctx.ui.notify(`Memory note ${note.id} is now ${note.status}.`, "info");
            await openMemoryDetail(
              ctx,
              `${note.kind}: ${note.summary}`,
              await formatMemoryNote(active, note),
            );
            return;
          }
          case "read": {
            const result = await active.runtime.memory.read(
              active.rootRunId,
              evidenceId(command.evidenceId),
            );
            await openMemoryDetail(
              ctx,
              `Evidence ${command.evidenceId}`,
              formatEvidence(result.evidence, result.content),
            );
            return;
          }
          case "browse":
            await browseMemory(ctx, active, command.query);
            return;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_shutdown", () => {
    binding = undefined;
  });
}

async function browseMemory(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  query: string | undefined,
): Promise<void> {
  const notes = await binding.runtime.memory.search({
    runId: binding.rootRunId,
    ...(query === undefined ? {} : { query }),
    limit: binding.runtime.memory.policy.storage.maximumSearchResults,
  });
  if (notes.length === 0) {
    ctx.ui.notify(
      query ? `No memory matched “${query}”.` : "No Phenix memory recorded yet.",
      "info",
    );
    return;
  }
  const selected = await selectMemoryNote(ctx, notes);
  if (!selected) return;
  const detail = await formatMemoryNote(binding, selected);
  await openMemoryDetail(ctx, `${selected.kind}: ${selected.summary}`, detail);
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
  if (note.status === "invalidated" && note.invalidatedBy) {
    lines.push("", `Invalidated by: ${note.invalidatedBy}`);
  }
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

function formatMemoryHealth(health: MemoryHealthSnapshot): string {
  const lines = [
    `State: ${health.state}`,
    `Writable: ${health.writable ? "yes" : "no"}`,
    `Evidence: ${health.evidenceCount}`,
    `Notes: ${health.noteCount} (${health.activeNoteCount} active)`,
    `Stored evidence: ${health.storedBytes} bytes`,
    `Ledger: ${health.ledgerBytes} bytes`,
    `Verified evidence: ${health.verifiedEvidenceCount}`,
  ];
  if (health.issues.length === 0) {
    lines.push("", "No integrity issues detected.");
    return lines.join("\n");
  }
  lines.push("", "Issues:");
  for (const issue of health.issues) lines.push(formatMemoryIssue(issue));
  return lines.join("\n");
}

function formatMemorySnapshot(snapshot: MemorySnapshot): string {
  return [
    formatMemoryHealth(snapshot.health),
    "",
    `Current evidence records: ${snapshot.stats.evidenceCount}`,
    `Current active notes: ${snapshot.stats.activeNoteCount}`,
    `Current evidence bytes: ${snapshot.stats.storedBytes}`,
    "",
    "Notes:",
    ...snapshot.notes.map(
      (note) => `- ${note.id} [${note.kind}/${note.status}] ${note.summary}`,
    ),
  ].join("\n");
}

function formatMemoryIssue(issue: MemoryIntegrityIssue): string {
  switch (issue.kind) {
    case "ledger-tail-truncated":
      return `- recoverable ledger tail at line ${issue.line}: ${issue.message}`;
    case "ledger-entry-corrupt":
      return `- corrupt ledger entry at line ${issue.line}: ${issue.message}`;
    case "repository-unavailable":
      return `- repository unavailable: ${issue.message}`;
    case "note-evidence-missing":
      return `- note ${issue.noteId} references missing evidence ${issue.evidenceId}`;
    case "note-reference-missing":
      return `- note ${issue.noteId} ${issue.relation} missing note ${issue.referencedNoteId}`;
    case "note-reference-invalid":
      return `- note ${issue.noteId} has invalid ${issue.relation} reference ${issue.referencedNoteId}: ${issue.reason}`;
    case "note-supersession-cycle":
      return `- supersession cycle: ${issue.noteIds.join(" -> ")}`;
    case "evidence-missing":
      return `- evidence ${issue.evidenceId} payload is missing (${issue.contentHash})`;
    case "evidence-size-mismatch":
      return `- evidence ${issue.evidenceId} size mismatch: expected ${issue.expectedBytes}, got ${issue.actualBytes}`;
    case "evidence-hash-mismatch":
      return `- evidence ${issue.evidenceId} hash mismatch: expected ${issue.expectedHash}, got ${issue.actualHash}`;
  }
}

function formatEvidence(
  evidence: Awaited<ReturnType<WorkspaceRuntimeBinding["runtime"]["memory"]["read"]>>["evidence"],
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
