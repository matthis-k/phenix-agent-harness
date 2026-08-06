import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

import { MEMORY_KINDS } from "./model.ts";

const MemoryStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("superseded"),
  Type.Literal("invalidated"),
  Type.Literal("uncertain"),
]);

const MemoryRetentionSchema = Type.Union([
  Type.Literal("must-retain"),
  Type.Literal("structured-lossless"),
  Type.Literal("summary-sufficient"),
  Type.Literal("ephemeral"),
]);

const MemoryReliabilitySchema = Type.Union([
  Type.Literal("observed"),
  Type.Literal("derived"),
  Type.Literal("reported"),
]);

const MemoryKindSchema = Type.Union(MEMORY_KINDS.map((kind) => Type.Literal(kind)));

const SetStatusSchema = Type.Union([
  ...(["active", "superseded", "uncertain"] as const).map((status) =>
    Type.Object(
      {
        action: Type.Literal("set_status"),
        noteId: Type.String({ minLength: 1, maxLength: 160 }),
        status: Type.Literal(status),
      },
      { additionalProperties: false },
    ),
  ),
  Type.Object(
    {
      action: Type.Literal("set_status"),
      noteId: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Literal("invalidated"),
      invalidatedBy: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    },
    { additionalProperties: false },
  ),
]);

export const MEMORY_TOOL_PARAMETERS = Type.Union([
  Type.Object({ action: Type.Literal("snapshot") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("health"),
      verifyEvidence: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("search"),
      query: Type.Optional(Type.String()),
      kind: Type.Optional(MemoryKindSchema),
      status: Type.Optional(MemoryStatusSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("read"),
      evidenceId: Type.String({ minLength: 1, maxLength: 160 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("note"),
      kind: MemoryKindSchema,
      summary: Type.String({ minLength: 1, maxLength: 2_000 }),
      subject: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      evidenceIds: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
          maxItems: 32,
          uniqueItems: true,
        }),
      ),
      retention: Type.Optional(MemoryRetentionSchema),
      reliability: Type.Optional(MemoryReliabilitySchema),
      status: Type.Optional(MemoryStatusSchema),
      supersedes: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 160 }), {
          maxItems: 32,
          uniqueItems: true,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  SetStatusSchema,
]);

export type MemoryToolRequest = Static<typeof MEMORY_TOOL_PARAMETERS>;

export function parseMemoryToolRequest(value: unknown): MemoryToolRequest {
  if (Check(MEMORY_TOOL_PARAMETERS, value)) return value as MemoryToolRequest;
  const issues = Errors(MEMORY_TOOL_PARAMETERS, value)
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid phenix_memory request: ${issues || "schema mismatch"}`);
}
