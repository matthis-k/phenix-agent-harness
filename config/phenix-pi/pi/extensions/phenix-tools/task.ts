/**
 * task tool — durable task/subtask records with task nesting support.
 *
 * Phase 1: task declaration + state management. Phase 2: task nesting (not subagent execution — see phenix-subagent-executor.ts for real subagent runs).
 * Current implementation stores task records in session state.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState, saveState, nextId } from "./_shared.js";
import type { TaskRecord } from "./_shared.js";

type TaskOp = "create" | "list" | "read" | "update" | "finish";
type TaskRole = "planner" | "implementer" | "verifier" | "critic";
type TaskStatus = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";

interface TaskParams {
  op: TaskOp;
  title?: string;
  prompt?: string;
  role?: TaskRole;
  parentId?: string;
  outputSchema?: unknown;
  id?: string;
  status?: TaskStatus;
  result?: unknown;
}

export function registerTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Durable task/subtask records with status tracking. Phase 1: declaration and state management. Phase 2: task nesting with PHENIX_ENABLE_TASK_NESTING=1.",
    promptSnippet: "Task/subtask records for workflow state tracking. Subagent execution uses phenix-subagent-executor.",
    promptGuidelines: [
      "Use task for durable task records with structured status tracking.",
      "Phase 1: create, list, read, update, finish task records in session state.",
      "Phase 2 (PHENIX_ENABLE_TASK_NESTING=1): allow deeper task nesting. Real subagent execution uses phenix-subagent-executor.",
      "Max nesting depth is 1 by default to prevent runaway subagents.",
      "Deep task nesting requires PHENIX_ENABLE_TASK_NESTING=1. Real subagent execution is in phenix-subagent-executor."
    ],
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("read"),
        Type.Literal("update"),
        Type.Literal("finish"),
      ], { description: "Operation" }),
      title: Type.Optional(Type.String({ description: "Task title (required for create)" })),
      prompt: Type.Optional(Type.String({ description: "Task prompt/description" })),
      role: Type.Optional(Type.Union([
        Type.Literal("planner"),
        Type.Literal("implementer"),
        Type.Literal("verifier"),
        Type.Literal("critic"),
      ], { description: "Task role" })),
      parentId: Type.Optional(Type.String({ description: "Parent task ID for nesting" })),
      outputSchema: Type.Optional(Type.Any({ description: "Expected output schema" })),
      id: Type.Optional(Type.String({ description: "Task ID (for read/update/finish)" })),
      status: Type.Optional(Type.Union([
        Type.Literal("queued"),
        Type.Literal("running"),
        Type.Literal("blocked"),
        Type.Literal("done"),
        Type.Literal("failed"),
        Type.Literal("cancelled"),
      ], { description: "Task status" })),
      result: Type.Optional(Type.Any({ description: "Task result data" })),
    }),
    async execute(_toolCallId: string, params: TaskParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("cancelled");

      const state = getState(ctx);

      switch (params.op) {
        case "create": {
          if (!params.title) {
            return { content: [{ type: "text", text: "title is required for create." }], details: {} };
          }

          // Check max depth if parentId is specified
          if (params.parentId) {
            const parent = state.tasks.find((t) => t.id === params.parentId);
            if (!parent) {
              return { content: [{ type: "text", text: `Parent task not found: ${params.parentId}` }], details: {} };
            }
            const depth = countDepth(state.tasks, params.parentId);
            if (depth >= 1 && !process.env.PHENIX_ENABLE_TASK_NESTING) {
              return { content: [{ type: "text", text: "Max task depth (1) reached. Set PHENIX_ENABLE_TASK_NESTING=1 to allow deeper nesting." }], details: {} };
            }
          }

          const task: TaskRecord = {
            id: nextId(),
            title: params.title,
            prompt: params.prompt,
            role: params.role,
            status: params.status ?? "queued",
            parentId: params.parentId,
            createdAt: Date.now(),
          };

          state.tasks.push(task);
          saveState(ctx);

          return {
            content: [{ type: "text", text: `Created task: [${task.status}] ${task.title} (id: ${task.id})` }],
            details: { task },
          };
        }

        case "list": {
          if (state.tasks.length === 0) {
            return { content: [{ type: "text", text: "No tasks." }], details: { tasks: [] } };
          }

          const lines = state.tasks.map((t) => {
            const indent = t.parentId ? "  " : "";
            return `${indent}[${t.status}] ${t.id}: ${t.title}${t.role ? ` (${t.role})` : ""}`;
          });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { tasks: state.tasks },
          };
        }

        case "read": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for read." }], details: {} };
          }

          const task = state.tasks.find((t) => t.id === params.id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
          }

          return {
            content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
            details: { task },
          };
        }

        case "update": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for update." }], details: {} };
          }

          const task = state.tasks.find((t) => t.id === params.id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
          }

          if (params.title !== undefined) task.title = params.title;
          if (params.prompt !== undefined) task.prompt = params.prompt;
          if (params.status !== undefined) task.status = params.status;
          if (params.result !== undefined) task.result = params.result;

          saveState(ctx);

          return {
            content: [{ type: "text", text: `Updated task: [${task.status}] ${task.title} (id: ${task.id})` }],
            details: { task },
          };
        }

        case "finish": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for finish." }], details: {} };
          }

          const task = state.tasks.find((t) => t.id === params.id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.id}` }], details: {} };
          }

          task.status = params.result ? "done" : "done";
          if (params.result !== undefined) task.result = params.result;

          saveState(ctx);

          return {
            content: [{ type: "text", text: `Finished task: ${task.title} (id: ${task.id})` }],
            details: { task },
          };
        }

        default:
          return { content: [{ type: "text", text: `Unknown operation: ${params.op}` }], details: {} };
      }
    },
  });
}

function countDepth(tasks: TaskRecord[], parentId: string): number {
  let depth = 0;
  let current = parentId;
  while (current) {
    const parent = tasks.find((t) => t.id === current);
    if (!parent?.parentId) break;
    current = parent.parentId;
    depth++;
  }
  return depth;
}
