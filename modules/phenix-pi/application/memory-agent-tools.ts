import { Type } from "typebox";

import {
  evidenceId,
  MEMORY_KINDS,
  memoryNoteId,
  type MemoryKind,
  type MemoryReliability,
  type MemoryRetention,
  type MemoryStatus,
} from "../domain/memory/model.ts";
import { defineSchema } from "../domain/definition/schema.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import type { AgentToolFactory } from "./agent-tools.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { MemoryService } from "./memory-service.ts";

const memoryParameters = defineSchema<{
  action: "snapshot" | "search" | "read" | "note" | "set_status";
  evidenceId?: string;
  noteId?: string;
  query?: string;
  kind?: MemoryKind;
  status?: MemoryStatus;
  summary?: string;
  subject?: string;
  evidenceIds?: string[];
  retention?: MemoryRetention;
  reliability?: MemoryReliability;
  supersedes?: string[];
  offset?: number;
  limit?: number;
}>(
  "tool.phenix-memory",
  Type.Object({
    action: Type.Enum(["snapshot", "search", "read", "note", "set_status"]),
    evidenceId: Type.Optional(Type.String()),
    noteId: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Enum(MEMORY_KINDS)),
    status: Type.Optional(Type.Enum(["active", "superseded", "invalidated", "uncertain"])),
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    subject: Type.Optional(Type.String({ maxLength: 500 })),
    evidenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
    retention: Type.Optional(
      Type.Enum(["must-retain", "structured-lossless", "summary-sufficient", "ephemeral"]),
    ),
    reliability: Type.Optional(Type.Enum(["observed", "derived", "reported"])),
    supersedes: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  }),
);

export class MemoryAgentToolFactory implements AgentToolFactory {
  private readonly memory: MemoryService;
  private readonly store: ExecutionStore;

  constructor(input: { readonly memory: MemoryService; readonly store: ExecutionStore }) {
    this.memory = input.memory;
    this.store = input.store;
  }

  async forRun(runId: RunId): Promise<readonly AgentTool[]> {
    const tool: AgentTool = {
      name: "phenix_memory",
      label: "Phenix Memory",
      description:
        "Inspect the reversible Phenix memory graph. Search returns compact typed notes; read reopens exact immutable evidence by evidenceId. Record only durable requirements, constraints, decisions, findings, preferences, procedures, or project facts with note. Use set_status when a note becomes superseded, invalidated, uncertain, or active again. Routine execution telemetry and tool results are captured automatically.",
      parameters: memoryParameters,
      execute: async (raw) => {
        const params = requireValid(raw);
        const rootRunId = this.store.projection.rootOf(runId);
        switch (params.action) {
          case "snapshot":
            return result(await this.memory.snapshot(rootRunId));
          case "search":
            return result(
              await this.memory.search({
                runId,
                ...(params.query ? { query: params.query } : {}),
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.status ? { status: params.status } : {}),
                ...(params.limit ? { limit: Math.min(100, params.limit) } : {}),
              }),
            );
          case "read": {
            if (!params.evidenceId) throw new Error("read requires evidenceId");
            const value = await this.memory.read(runId, evidenceId(params.evidenceId));
            const offset = params.offset ?? 0;
            const limit = params.limit ?? 20_000;
            const content = value.content.slice(offset, offset + limit);
            return result({
              evidence: value.evidence,
              content,
              offset,
              returnedBytes: Buffer.byteLength(content, "utf8"),
              totalBytes: Buffer.byteLength(value.content, "utf8"),
              truncated: offset + content.length < value.content.length,
            });
          }
          case "note": {
            if (!params.kind) throw new Error("note requires kind");
            if (!params.summary?.trim()) throw new Error("note requires summary");
            return result(
              await this.memory.recordNote({
                runId,
                kind: params.kind,
                summary: params.summary,
                ...(params.subject ? { subject: params.subject } : {}),
                ...(params.evidenceIds
                  ? { evidenceIds: params.evidenceIds.map((id) => evidenceId(id)) }
                  : {}),
                ...(params.retention ? { retention: params.retention } : {}),
                ...(params.reliability ? { reliability: params.reliability } : {}),
                ...(params.status ? { status: params.status } : {}),
                ...(params.supersedes
                  ? { supersedes: params.supersedes.map((id) => memoryNoteId(id)) }
                  : {}),
              }),
            );
          }
          case "set_status":
            if (!params.noteId) throw new Error("set_status requires noteId");
            if (!params.status) throw new Error("set_status requires status");
            return result(
              await this.memory.setStatus(runId, memoryNoteId(params.noteId), params.status),
            );
        }
      },
    };
    return [tool];
  }
}

function requireValid(value: unknown) {
  const validation = memoryParameters.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}

function result(value: unknown) {
  return { text: JSON.stringify(value), details: value };
}
