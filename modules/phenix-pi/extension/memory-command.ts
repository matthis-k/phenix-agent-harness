import type { MemoryStatus } from "../domain/memory/model.ts";

export const MEMORY_COMMAND_USAGE = [
  "/memory [search terms]",
  "/memory read <evidence-id>",
  "/memory health",
  "/memory verify",
  "/memory snapshot",
  "/memory policy",
  "/memory repair",
  "/memory maintain",
  "/memory set-status <note-id> <active|uncertain|superseded>",
  "/memory set-status <note-id> invalidated [invalidating-note-id]",
].join("\n");

export type MemoryCommand =
  | { readonly kind: "browse"; readonly query?: string }
  | { readonly kind: "read"; readonly evidenceId: string }
  | { readonly kind: "health"; readonly verifyEvidence: boolean }
  | { readonly kind: "snapshot" }
  | { readonly kind: "policy" }
  | { readonly kind: "repair" }
  | { readonly kind: "maintain" }
  | {
      readonly kind: "set-status";
      readonly noteId: string;
      readonly status: Exclude<MemoryStatus, "invalidated">;
    }
  | {
      readonly kind: "set-status";
      readonly noteId: string;
      readonly status: "invalidated";
      readonly invalidatedBy?: string;
    }
  | { readonly kind: "help" };

export function parseMemoryCommand(input: string): MemoryCommand {
  const request = input.trim();
  if (!request) return { kind: "browse" };
  if (request === "help" || request === "--help" || request === "-h") return { kind: "help" };
  if (request === "health") return { kind: "health", verifyEvidence: false };
  if (request === "verify") return { kind: "health", verifyEvidence: true };
  if (request === "snapshot") return { kind: "snapshot" };
  if (request === "policy") return { kind: "policy" };
  if (request === "repair") return { kind: "repair" };
  if (request === "maintain") return { kind: "maintain" };

  const [command, ...arguments_] = request.split(/\s+/);
  if (command === "read") {
    const [evidenceId, ...extra] = arguments_;
    if (!evidenceId || extra.length > 0) throw new Error("Usage: /memory read <evidence-id>");
    return { kind: "read", evidenceId };
  }
  if (command === "set-status") {
    const [noteId, rawStatus, invalidatedBy, ...extra] = arguments_;
    if (!noteId || !rawStatus || extra.length > 0) throw new Error(MEMORY_COMMAND_USAGE);
    const status = parseStatus(rawStatus);
    if (status === "invalidated") {
      return {
        kind: "set-status",
        noteId,
        status,
        ...(invalidatedBy === undefined ? {} : { invalidatedBy }),
      };
    }
    if (invalidatedBy !== undefined) {
      throw new Error("An invalidating note ID is only valid with status invalidated");
    }
    return { kind: "set-status", noteId, status };
  }
  return { kind: "browse", query: request };
}

function parseStatus(value: string): MemoryStatus {
  switch (value) {
    case "active":
    case "uncertain":
    case "superseded":
    case "invalidated":
      return value;
    default:
      throw new Error(`Unknown memory status: ${value}`);
  }
}
