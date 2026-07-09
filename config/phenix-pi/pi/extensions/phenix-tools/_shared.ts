/**
 * Phenix tools — shared helpers for workspace-safe, bounded tool operations.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve, isAbsolute, normalize, sep } from "node:path";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ──────────────────────────────────────────────
// Limits
// ──────────────────────────────────────────────

export const MAX_READ_BYTES = 50 * 1024; // 50 KB
export const MAX_READ_LINES = 2000;
export const MAX_SEARCH_MATCHES = 100;
export const MAX_FIND_RESULTS = 100;
export const MAX_JOB_OUTPUT_BYTES = 50_000;
export const MAX_TOOL_OUTPUT_BYTES = 50_000;
export const MAX_EDIT_PREVIEW_LINES = 200;
export const MAX_AST_MATCHES = 50;
export const LSP_TIMEOUT_MS = 15_000;

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────

export function resolveWorkspacePath(cwd: string, input: string): string {
  const resolved = resolve(cwd, input);
  assertInsideWorkspace(cwd, resolved);
  return resolved;
}

export function assertInsideWorkspace(cwd: string, path: string): void {
  const normalized = normalize(path);
  // Allow /nix/store paths explicitly
  if (normalized.startsWith("/nix/store/")) return;
  const rel = relative(cwd, normalized);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path outside workspace: ${path} (resolved: ${normalized})`);
  }
}

export function normalizePathForDisplay(path: string): string {
  return path.replace(/^\/home\/[^/]+/, "~");
}

// ──────────────────────────────────────────────
// Hash
// ──────────────────────────────────────────────

export function sha256String(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path, "utf8");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ──────────────────────────────────────────────
// Diff
// ──────────────────────────────────────────────

export function unifiedDiff(oldText: string, newText: string, path: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const displayPath = normalizePathForDisplay(path);

  // Simple diff: show the first contiguous changed region
  let startOld = 0;
  let startNew = 0;
  while (startOld < oldLines.length && startNew < newLines.length && oldLines[startOld] === newLines[startNew]) {
    startOld++;
    startNew++;
  }

  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= startOld && endNew >= startNew && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }

  if (startOld > endOld && startNew > endNew) {
    return `(no changes to ${displayPath})`;
  }

  const ctx = 2; // context lines
  const hunkStartOld = Math.max(0, startOld - ctx);
  const hunkStartNew = Math.max(0, startNew - ctx);
  const hunkEndOld = Math.min(oldLines.length - 1, endOld + ctx);
  const hunkEndNew = Math.min(newLines.length - 1, endNew + ctx);

  const lines: string[] = [];
  lines.push(`--- a/${displayPath}`);
  lines.push(`+++ b/${displayPath}`);
  lines.push(`@@ -${hunkStartOld + 1},${hunkEndOld - hunkStartOld + 1} +${hunkStartNew + 1},${hunkEndNew - hunkStartNew + 1} @@`);

  for (let i = hunkStartOld; i <= hunkEndOld; i++) {
    const isRemoved = i >= startOld && i <= endOld;
    if (isRemoved) {
      lines.push(`-${oldLines[i]}`);
    } else if (i - hunkStartOld + hunkStartNew - startOld + startNew <= hunkEndNew) {
      // Check if this line exists in the new text at the matching position
      const newIdx = hunkStartNew + (i - hunkStartOld);
      if (newIdx <= hunkEndNew && newIdx < startNew) {
        lines.push(` ${oldLines[i]}`);
      } else if (newIdx > endNew) {
        lines.push(` ${oldLines[i]}`);
      } else {
        lines.push(`-${oldLines[i]}`);
      }
    }
  }

  for (let i = hunkStartNew; i <= hunkEndNew; i++) {
    const isAdded = i >= startNew && i <= endNew;
    const oldIdx = hunkStartOld + (i - hunkStartNew);
    const wasRemoved = oldIdx >= startOld && oldIdx <= endOld;
    if (isAdded && !wasRemoved) {
      lines.push(`+${newLines[i]}`);
    } else if (!isAdded && oldIdx >= hunkStartOld && oldIdx <= hunkEndOld && oldIdx < startOld) {
      // common context
    } else if (!isAdded && oldIdx > endOld) {
      lines.push(` ${newLines[i]}`);
    }
  }

  return lines.join("\n");
}

export function generateDiff(oldText: string, newText: string, path: string): string {
  // Simple line-based diff marker
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const displayPath = normalizePathForDisplay(path);
  const result: string[] = [`--- ${displayPath}`, `+++ ${displayPath}`];

  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      result.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        result.push(`-${oldLines[i]}`);
        i++;
      }
      if (j < newLines.length) {
        result.push(`+${newLines[j]}`);
        j++;
      }
    }
  }

  return result.slice(0, MAX_EDIT_PREVIEW_LINES + 2).join("\n") + (result.length > MAX_EDIT_PREVIEW_LINES + 2 ? "\n... (truncated)" : "");
}

// ──────────────────────────────────────────────
// State persistence
// ──────────────────────────────────────────────

export interface PendingAction {
  id: string;
  kind: "edit" | "ast_edit" | "other";
  createdAt: number;
  path?: string;
  description: string;
  diff?: string;
  /** Serialized data for applying/rejecting */
  data: {
    path?: string;
    edits?: Array<{ old: string; new: string; occurrence?: number }>;
    shaBefore?: string;
    newContent?: string;
    oldContent?: string;
    [key: string]: unknown;
  };
}

export interface TodoItem {
  id: string;
  title: string;
  phase: "planned" | "implementing" | "blocked" | "verifying" | "done" | "cancelled";
  parentId?: string;
  order: number;
  details?: string;
  evidence?: unknown;
}

export interface TaskRecord {
  id: string;
  title: string;
  prompt?: string;
  role?: "planner" | "implementer" | "verifier" | "critic";
  status: "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";
  parentId?: string;
  result?: unknown;
  createdAt: number;
}

export interface JobRecord {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  status: "running" | "done" | "cancelled" | "failed";
  exitCode?: number;
  stdoutFile?: string;
  stderrFile?: string;
  startTime: number;
  endTime?: number;
}

export interface PhenixToolsState {
  pendingActions: Record<string, PendingAction>;
  todoItems: TodoItem[];
  tasks: TaskRecord[];
  jobs: Record<string, JobRecord>;
  fileHashes: Record<string, string>;
}

const STATE_CUSTOM_TYPE = "phenix-tools-state";
const TODO_CUSTOM_TYPE = "phenix-tools-todos";

let _piApi: ExtensionAPI | undefined;
let _state: PhenixToolsState = {
  pendingActions: {},
  todoItems: [],
  tasks: [],
  jobs: {},
  fileHashes: {},
};

export function setExtensionAPI(pi: ExtensionAPI): void {
  _piApi = pi;
}

export function getState(ctx: ExtensionContext): PhenixToolsState {
  // Lazy-load from session entries if first access in this session
  if (Object.keys(_state.pendingActions).length === 0 && ctx.sessionManager) {
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE && entry.data) {
          const loaded = entry.data as Partial<PhenixToolsState>;
          if (loaded.pendingActions) _state.pendingActions = { ..._state.pendingActions, ...loaded.pendingActions };
          if (loaded.fileHashes) _state.fileHashes = { ..._state.fileHashes, ...loaded.fileHashes };
        }
        if (entry.type === "custom" && entry.customType === TODO_CUSTOM_TYPE && entry.data) {
          const loaded = entry.data as Partial<PhenixToolsState>;
          if (loaded.todoItems) _state.todoItems = loaded.todoItems;
          if (loaded.tasks) _state.tasks = loaded.tasks;
        }
      }
    } catch {
      // Quietly handle missing session entries
    }
  }
  return _state;
}

export function saveState(ctx: ExtensionContext): void {
  if (!_piApi) return;
  try {
    _piApi.appendEntry(STATE_CUSTOM_TYPE, {
      pendingActions: _state.pendingActions,
      fileHashes: _state.fileHashes,
    });
    _piApi.appendEntry(TODO_CUSTOM_TYPE, {
      todoItems: _state.todoItems,
      tasks: _state.tasks,
    });
  } catch {
    // Best-effort persistence
  }
}

export function resetActionCounter(): void {
  // Counter is derived from Date.now() for uniqueness
}

export function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ──────────────────────────────────────────────
// File size / format helpers
// ──────────────────────────────────────────────

export async function getFileInfo(path: string): Promise<{ bytes: number; lineCount: number }> {
  const st = await stat(path);
  const content = await readFile(path, "utf8");
  return { bytes: st.size, lineCount: content.split("\n").length };
}

export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD/g, "") + "\n... (truncated)", truncated: true };
}

export function isDir(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory()).catch(() => false);
}
