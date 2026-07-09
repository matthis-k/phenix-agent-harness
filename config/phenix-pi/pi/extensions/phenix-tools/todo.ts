/**
 * todo tool — structured session/workflow checklist.
 *
 * Maintains ordered list with phase tracking. State persisted via session entries.
 *
 * Portions derived from can1357/oh-my-pi, MIT License.
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState, saveState, nextId } from "./_shared.js";
import type { TodoItem } from "./_shared.js";

type TodoOp = "list" | "add" | "update" | "done" | "remove" | "clear";
type TodoPhase = "planned" | "implementing" | "blocked" | "verifying" | "done" | "cancelled";

interface TodoParams {
  op: TodoOp;
  id?: string;
  title?: string;
  phase?: TodoPhase;
  parentId?: string;
  details?: string;
  evidence?: unknown;
}

export function registerTodo(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description: "Structured session/workflow checklist with phase tracking. Supports list, add, update, done, remove, clear operations.",
    promptSnippet: "Structured task checklist with phase tracking (planned → implementing → verifying → done).",
    promptGuidelines: [
      "Use todo to track workflow progress with phases: planned, implementing, blocked, verifying, done, cancelled.",
      "Supports parent/child relationships (parentId) but not full DAG yet.",
      "State persists within the session and survives restarts.",
      "Use todo add to create items, todo done to mark complete, todo list to view all."
    ],
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("list"),
        Type.Literal("add"),
        Type.Literal("update"),
        Type.Literal("done"),
        Type.Literal("remove"),
        Type.Literal("clear"),
      ], { description: "Operation" }),
      id: Type.Optional(Type.String({ description: "Item ID (for update/done/remove)" })),
      title: Type.Optional(Type.String({ description: "Title for add/update" })),
      phase: Type.Optional(Type.Union([
        Type.Literal("planned"),
        Type.Literal("implementing"),
        Type.Literal("blocked"),
        Type.Literal("verifying"),
        Type.Literal("done"),
        Type.Literal("cancelled"),
      ], { description: "Phase for add/update" })),
      parentId: Type.Optional(Type.String({ description: "Parent item ID for nesting" })),
      details: Type.Optional(Type.String({ description: "Detailed notes" })),
      evidence: Type.Optional(Type.Any({ description: "Evidence data for the item" })),
    }),
    async execute(_toolCallId: string, params: TodoParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("cancelled");

      const state = getState(ctx);

      switch (params.op) {
        case "list": {
          if (state.todoItems.length === 0) {
            return { content: [{ type: "text", text: "No todo items." }], details: { items: [] } };
          }

          const lines = state.todoItems
            .sort((a, b) => a.order - b.order)
            .map((item) => {
              const indent = item.parentId ? "  " : "";
              return `${indent}[${item.phase}] ${item.id}: ${item.title}${item.details ? ` — ${item.details}` : ""}`;
            });

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { items: state.todoItems },
          };
        }

        case "add": {
          if (!params.title) {
            return { content: [{ type: "text", text: "title is required for add." }], details: {} };
          }

          const item: TodoItem = {
            id: params.id ?? nextId(),
            title: params.title,
            phase: params.phase ?? "planned",
            parentId: params.parentId,
            order: state.todoItems.length + 1,
            details: params.details,
            evidence: params.evidence,
          };

          state.todoItems.push(item);
          saveState(ctx);

          return {
            content: [{ type: "text", text: `Added todo: [${item.phase}] ${item.title} (id: ${item.id})` }],
            details: { item, items: state.todoItems },
          };
        }

        case "update": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for update." }], details: {} };
          }

          const idx = state.todoItems.findIndex((i) => i.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: `Todo item not found: ${params.id}` }], details: {} };
          }

          const existing = state.todoItems[idx];
          if (params.title !== undefined) existing.title = params.title;
          if (params.phase !== undefined) existing.phase = params.phase;
          if (params.details !== undefined) existing.details = params.details;
          if (params.evidence !== undefined) existing.evidence = params.evidence;

          saveState(ctx);

          return {
            content: [{ type: "text", text: `Updated todo: [${existing.phase}] ${existing.title} (id: ${existing.id})` }],
            details: { item: existing, items: state.todoItems },
          };
        }

        case "done": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for done." }], details: {} };
          }

          const idx = state.todoItems.findIndex((i) => i.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: `Todo item not found: ${params.id}` }], details: {} };
          }

          state.todoItems[idx].phase = "done";
          saveState(ctx);

          return {
            content: [{ type: "text", text: `Marked done: ${state.todoItems[idx].title}` }],
            details: { item: state.todoItems[idx], items: state.todoItems },
          };
        }

        case "remove": {
          if (!params.id) {
            return { content: [{ type: "text", text: "id is required for remove." }], details: {} };
          }

          const idx = state.todoItems.findIndex((i) => i.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: `Todo item not found: ${params.id}` }], details: {} };
          }

          const removed = state.todoItems.splice(idx, 1)[0];
          saveState(ctx);

          return {
            content: [{ type: "text", text: `Removed todo: ${removed.title}` }],
            details: { removed, items: state.todoItems },
          };
        }

        case "clear": {
          state.todoItems = [];
          saveState(ctx);
          return { content: [{ type: "text", text: "Cleared all todo items." }], details: { items: [] } };
        }

        default:
          return { content: [{ type: "text", text: `Unknown operation: ${params.op}` }], details: {} };
      }
    },
  });
}
