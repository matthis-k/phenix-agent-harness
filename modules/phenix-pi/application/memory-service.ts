import { createHash } from "node:crypto";

import {
  type EvidenceId,
  type EvidenceRecord,
  type EvidenceSource,
  evidenceId,
  type MemoryKind,
  type MemoryNote,
  type MemoryNoteId,
  type MemoryReliability,
  type MemoryRetention,
  type MemorySnapshot,
  type MemoryStatus,
  memoryNoteId,
  type WorkingMemoryProjection,
} from "../domain/memory/model.ts";
import { focusedObjectiveId } from "../domain/objective/projection.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type { RunFactRecordedData } from "../domain/run/observability.ts";
import type { ObjectiveId, RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { MemoryRepository } from "../ports/memory-repository.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

interface RootMemoryState {
  readonly evidence: Map<EvidenceId, EvidenceRecord>;
  readonly notes: Map<MemoryNoteId, MemoryNote>;
  readonly evidenceByToolCall: Map<string, EvidenceId>;
}

export interface CaptureToolResultInput {
  readonly runId: RunId;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly content: unknown;
  readonly details?: unknown;
  readonly isError: boolean;
}

export interface RecordMemoryNoteInput {
  readonly runId: RunId;
  readonly kind: MemoryKind;
  readonly summary: string;
  readonly subject?: string;
  readonly evidenceIds?: readonly EvidenceId[];
  readonly retention?: MemoryRetention;
  readonly reliability?: MemoryReliability;
  readonly status?: MemoryStatus;
  readonly supersedes?: readonly MemoryNoteId[];
}

export interface SearchMemoryInput {
  readonly runId: RunId;
  readonly query?: string;
  readonly kind?: MemoryKind;
  readonly status?: MemoryStatus;
  readonly objectiveId?: ObjectiveId;
  readonly limit?: number;
}

export interface MemoryReadResult {
  readonly evidence: EvidenceRecord;
  readonly content: string;
}

export type MemoryListener = () => void;

export class MemoryService {
  private readonly repository: MemoryRepository;
  private readonly store: ExecutionStore;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly roots = new Map<RunId, RootMemoryState>();
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly listeners = new Set<MemoryListener>();
  private readonly unsubscribeEvents: () => void;

  constructor(input: {
    readonly repository: MemoryRepository;
    readonly store: ExecutionStore;
    readonly ids: IdGenerator;
    readonly clock: Clock;
  }) {
    this.repository = input.repository;
    this.store = input.store;
    this.ids = input.ids;
    this.clock = input.clock;
    this.unsubscribeEvents = this.store.events.subscribe((event) => this.observeDomainEvent(event));
  }

  async initializeRoot(rootRunId: RunId): Promise<void> {
    await this.serial.run(rootRunId, () => this.ensureLoaded(rootRunId));
  }

  subscribe(listener: MemoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async captureToolResult(input: CaptureToolResultInput): Promise<EvidenceRecord> {
    const rootRunId = this.store.projection.rootOf(input.runId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.ensureLoaded(rootRunId);
      const existingId = state.evidenceByToolCall.get(toolCallKey(input.runId, input.toolCallId));
      const existing = existingId ? state.evidence.get(existingId) : undefined;
      if (existing) return existing;

      const serialized = safeSerialize({
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        input: input.input,
        content: input.content,
        details: input.details,
        isError: input.isError,
      });
      const summary = summarizeToolResult(input);
      const evidence = await this.persistEvidence(state, {
        rootRunId,
        runId: input.runId,
        source: {
          kind: "tool-result",
          toolName: input.toolName,
          toolCallId: input.toolCallId,
        },
        content: serialized,
        mediaType: "application/json",
        preview: summary,
      });
      state.evidenceByToolCall.set(toolCallKey(input.runId, input.toolCallId), evidence.id);

      if (input.toolName !== "phenix_progress") {
        const classification = classifyToolResult(input);
        await this.persistNote(state, {
          runId: input.runId,
          kind: classification.kind,
          summary,
          ...(classification.subject ? { subject: classification.subject } : {}),
          evidenceIds: [evidence.id],
          retention: classification.retention,
          reliability: "observed",
          status: input.isError ? "uncertain" : "active",
        });
      }
      this.emit();
      return evidence;
    });
  }

  async recordNote(input: RecordMemoryNoteInput): Promise<MemoryNote> {
    const rootRunId = this.store.projection.rootOf(input.runId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.ensureLoaded(rootRunId);
      const note = await this.persistNote(state, input);
      if (input.supersedes) {
        for (const previousId of input.supersedes) {
          const previous = state.notes.get(previousId);
          if (!previous || previous.status === "superseded") continue;
          await this.persistNoteValue(state, {
            ...previous,
            status: "superseded",
            updatedAt: this.clock.now(),
          });
        }
      }
      this.emit();
      return note;
    });
  }

  async setStatus(
    actorRunId: RunId,
    id: MemoryNoteId,
    status: MemoryStatus,
    invalidatedBy?: MemoryNoteId,
  ): Promise<MemoryNote> {
    const rootRunId = this.store.projection.rootOf(actorRunId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.ensureLoaded(rootRunId);
      const current = state.notes.get(id);
      if (!current) throw new Error(`Unknown memory note: ${id}`);
      const updated: MemoryNote = {
        ...current,
        status,
        ...(invalidatedBy ? { invalidatedBy } : {}),
        updatedAt: this.clock.now(),
      };
      await this.persistNoteValue(state, updated);
      this.emit();
      return updated;
    });
  }

  async read(runId: RunId, id: EvidenceId): Promise<MemoryReadResult> {
    const rootRunId = this.store.projection.rootOf(runId);
    const state = await this.ensureLoaded(rootRunId);
    const evidence = state.evidence.get(id);
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    const content = await this.repository.readEvidence(rootRunId, id);
    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);
    return { evidence, content };
  }

  async search(input: SearchMemoryInput): Promise<readonly MemoryNote[]> {
    const rootRunId = this.store.projection.rootOf(input.runId);
    const state = await this.ensureLoaded(rootRunId);
    const queryTerms = normalizeTerms(input.query);
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    return [...state.notes.values()]
      .filter((note) => !input.kind || note.kind === input.kind)
      .filter((note) => !input.status || note.status === input.status)
      .filter((note) => !input.objectiveId || note.objectiveIds.includes(input.objectiveId))
      .map((note) => ({ note, score: memoryScore(note, queryTerms, input.runId) }))
      .filter((candidate) => queryTerms.length === 0 || candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.note.updatedAt.localeCompare(left.note.updatedAt) ||
          String(left.note.id).localeCompare(String(right.note.id)),
      )
      .slice(0, limit)
      .map((candidate) => candidate.note);
  }

  async snapshot(rootRunId: RunId): Promise<MemorySnapshot> {
    const state = await this.ensureLoaded(rootRunId);
    const evidence = [...state.evidence.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    const notes = [...state.notes.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return {
      rootRunId,
      evidence,
      notes,
      stats: {
        evidenceCount: evidence.length,
        activeNoteCount: notes.filter((note) => note.status === "active").length,
        storedBytes: evidence.reduce((total, item) => total + item.sizeBytes, 0),
      },
    };
  }

  async workingSet(runId: RunId, limit = 24): Promise<WorkingMemoryProjection> {
    const rootRunId = this.store.projection.rootOf(runId);
    const state = await this.ensureLoaded(rootRunId);
    const objectivePath = this.objectivePath(runId);
    const objectiveIds = new Set(objectivePath.map((objective) => objective.id));
    const notes = [...state.notes.values()]
      .filter((note) => note.status === "active" || note.status === "uncertain")
      .filter(
        (note) =>
          note.runId === runId ||
          note.objectiveIds.length === 0 ||
          note.objectiveIds.some((id) => objectiveIds.has(id)),
      )
      .sort((left, right) => {
        const retention = retentionRank(right.retention) - retentionRank(left.retention);
        return retention || right.updatedAt.localeCompare(left.updatedAt);
      })
      .slice(0, Math.max(1, limit));
    const evidenceIds = new Set(notes.flatMap((note) => note.evidenceIds));
    const recentEvidence = [...state.evidence.values()]
      .filter((item) => evidenceIds.has(item.id) || item.runId === runId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 20);
    return { rootRunId, runId, objectivePath, notes, recentEvidence };
  }

  async evidenceForToolCall(runId: RunId, toolCallId: string): Promise<EvidenceRecord | undefined> {
    const rootRunId = this.store.projection.rootOf(runId);
    const state = await this.ensureLoaded(rootRunId);
    const id = state.evidenceByToolCall.get(toolCallKey(runId, toolCallId));
    return id ? state.evidence.get(id) : undefined;
  }

  shutdown(): void {
    this.unsubscribeEvents();
    this.listeners.clear();
    this.roots.clear();
  }

  private async ensureLoaded(rootRunId: RunId): Promise<RootMemoryState> {
    const existing = this.roots.get(rootRunId);
    if (existing) return existing;
    const persisted = await this.repository.load(rootRunId);
    const state: RootMemoryState = {
      evidence: new Map(persisted.evidence.map((item) => [item.id, item])),
      notes: new Map(persisted.notes.map((item) => [item.id, item])),
      evidenceByToolCall: new Map(
        persisted.evidence.flatMap((item) =>
          item.source.kind === "tool-result"
            ? [[toolCallKey(item.runId, item.source.toolCallId), item.id] as const]
            : [],
        ),
      ),
    };
    this.roots.set(rootRunId, state);
    return state;
  }

  private async persistEvidence(
    state: RootMemoryState,
    input: {
      readonly rootRunId: RunId;
      readonly runId: RunId;
      readonly source: EvidenceSource;
      readonly content: string;
      readonly mediaType: EvidenceRecord["mediaType"];
      readonly preview: string;
    },
  ): Promise<EvidenceRecord> {
    const contentHash = createHash("sha256").update(input.content).digest("hex");
    const record: EvidenceRecord = {
      id: evidenceId(this.ids.next("evidence")),
      rootRunId: input.rootRunId,
      runId: input.runId,
      objectiveIds: this.objectiveScope(input.runId),
      source: input.source,
      contentHash,
      mediaType: input.mediaType,
      sizeBytes: Buffer.byteLength(input.content, "utf8"),
      preview: truncate(input.preview, 320),
      createdAt: this.clock.now(),
    };
    await this.repository.appendEvidence(record, input.content);
    state.evidence.set(record.id, record);
    return record;
  }

  private async persistNote(
    state: RootMemoryState,
    input: RecordMemoryNoteInput,
  ): Promise<MemoryNote> {
    const now = this.clock.now();
    const rootRunId = this.store.projection.rootOf(input.runId);
    const note: MemoryNote = {
      id: memoryNoteId(this.ids.next("memory")),
      rootRunId,
      runId: input.runId,
      objectiveIds: this.objectiveScope(input.runId),
      kind: input.kind,
      status: input.status ?? "active",
      retention: input.retention ?? "summary-sufficient",
      reliability: input.reliability ?? "reported",
      summary: requireText(input.summary, "Memory summary"),
      ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
      evidenceIds: input.evidenceIds ?? [],
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.persistNoteValue(state, note);
    return note;
  }

  private async persistNoteValue(state: RootMemoryState, note: MemoryNote): Promise<void> {
    await this.repository.appendNote(note);
    state.notes.set(note.id, note);
  }

  private async observeDomainEvent(event: DomainEvent): Promise<void> {
    if (event.type === "run.fact.recorded") {
      const fact = event.data as RunFactRecordedData;
      const classification = classifyFact(fact);
      if (!classification) return;
      await this.captureDomainMemory({
        event,
        kind: classification.kind,
        summary: fact.summary,
        subject: fact.subject,
        reliability: fact.reliability,
        retention: classification.retention,
      });
      return;
    }
    if (!["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(event.type)) {
      return;
    }
    const run = this.store.projection.runs.get(event.runId);
    if (!run || run.kind === "root") return;
    const outcome = run.outcome ?? event.data;
    await this.captureDomainMemory({
      event,
      kind: event.type === "run.completed" ? "run-outcome" : "error",
      summary:
        event.type === "run.completed"
          ? `Run ${run.definitionId} completed`
          : `Run ${run.definitionId} ended with ${event.type.slice("run.".length)}`,
      subject: String(run.definitionId),
      reliability: "observed",
      retention: "structured-lossless",
      payload: outcome,
      source: { kind: "run-outcome", childRunId: event.runId },
    });
  }

  private async captureDomainMemory(input: {
    readonly event: DomainEvent;
    readonly kind: MemoryKind;
    readonly summary: string;
    readonly subject?: string;
    readonly reliability: MemoryReliability;
    readonly retention: MemoryRetention;
    readonly payload?: unknown;
    readonly source?: EvidenceSource;
  }): Promise<void> {
    const rootRunId = input.event.rootRunId;
    await this.serial.run(rootRunId, async () => {
      const state = await this.ensureLoaded(rootRunId);
      const content = safeSerialize(input.payload ?? input.event.data);
      const evidence = await this.persistEvidence(state, {
        rootRunId,
        runId: input.event.runId,
        source: input.source ?? { kind: "domain-event", eventId: input.event.eventId },
        content,
        mediaType: "application/json",
        preview: input.summary,
      });
      await this.persistNote(state, {
        runId: input.event.runId,
        kind: input.kind,
        summary: input.summary,
        ...(input.subject ? { subject: input.subject } : {}),
        evidenceIds: [evidence.id],
        reliability: input.reliability,
        retention: input.retention,
      });
      this.emit();
    });
  }

  private objectiveScope(runId: RunId): readonly ObjectiveId[] {
    return this.objectivePath(runId).map((objective) => objective.id);
  }

  private objectivePath(runId: RunId): WorkingMemoryProjection["objectivePath"] {
    const focused = focusedObjectiveId(this.store.projection, runId);
    if (!focused) return [];
    const result: Array<{ id: ObjectiveId; title: string; state: string }> = [];
    const visited = new Set<ObjectiveId>();
    let current = this.store.projection.objectives.get(focused);
    while (current) {
      if (visited.has(current.id)) throw new Error(`Objective ancestry cycle at ${current.id}`);
      visited.add(current.id);
      result.push({ id: current.id, title: current.title, state: current.state });
      current = current.parentObjectiveId
        ? this.store.projection.objectives.get(current.parentObjectiveId)
        : undefined;
    }
    return result.reverse();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function toolCallKey(runId: RunId, toolCallId: string): string {
  return `${runId}:${toolCallId}`;
}

function classifyToolResult(input: CaptureToolResultInput): {
  readonly kind: MemoryKind;
  readonly retention: MemoryRetention;
  readonly subject?: string;
} {
  const record = isRecord(input.input) ? input.input : {};
  const path = stringField(record, "path") ?? stringField(record, "file_path");
  if (input.isError) return { kind: "error", retention: "structured-lossless", subject: path };
  if (["edit", "write"].includes(input.toolName)) {
    return { kind: "change", retention: "structured-lossless", subject: path };
  }
  if (input.toolName === "bash" || input.toolName === "nix_shell") {
    const command = stringField(record, "command");
    return {
      kind:
        command &&
        /(?:^|\s)(?:test|check|pytest|vitest|jest|cargo test|flake check)(?:\s|$)/i.test(command)
          ? "test-result"
          : "observation",
      retention: "structured-lossless",
      subject: command,
    };
  }
  return {
    kind: "observation",
    retention: ["read", "grep", "find", "ls"].includes(input.toolName)
      ? "summary-sufficient"
      : "structured-lossless",
    subject: path,
  };
}

function classifyFact(
  fact: RunFactRecordedData,
): { readonly kind: MemoryKind; readonly retention: MemoryRetention } | undefined {
  switch (fact.kind) {
    case "decision-reported":
      return { kind: "decision", retention: "must-retain" };
    case "finding-reported":
      return { kind: "finding", retention: "structured-lossless" };
    case "error-observed":
      return { kind: "error", retention: "structured-lossless" };
    case "test-result":
      return { kind: "test-result", retention: "structured-lossless" };
    case "file-changed":
      return { kind: "change", retention: "structured-lossless" };
    default:
      return undefined;
  }
}

function summarizeToolResult(input: CaptureToolResultInput): string {
  const record = isRecord(input.input) ? input.input : {};
  const text = extractText(input.content) || extractText(input.details);
  const preview = compact(text) || (input.isError ? "Tool returned an error" : "Tool completed");
  const subject =
    stringField(record, "command") ??
    stringField(record, "path") ??
    stringField(record, "file_path") ??
    stringField(record, "pattern") ??
    stringField(record, "query");
  return truncate(`${input.toolName}${subject ? ` ${compact(subject)}` : ""}: ${preview}`, 320);
}

function memoryScore(note: MemoryNote, terms: readonly string[], runId: RunId): number {
  let score = retentionRank(note.retention) * 2;
  if (note.runId === runId) score += 6;
  if (note.status === "active") score += 3;
  if (note.status === "uncertain") score += 1;
  if (terms.length === 0) return score;
  const haystack = `${note.kind} ${note.subject ?? ""} ${note.summary}`.toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) score += term.includes(" ") ? 8 : 4;
  }
  return score;
}

function retentionRank(retention: MemoryRetention): number {
  switch (retention) {
    case "must-retain":
      return 4;
    case "structured-lossless":
      return 3;
    case "summary-sufficient":
      return 2;
    case "ephemeral":
      return 1;
  }
}

function normalizeTerms(query: string | undefined): readonly string[] {
  if (!query?.trim()) return [];
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])];
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    for (const field of ["output", "stdout", "stderr", "text", "content", "message"]) {
      const candidate = value[field];
      const extracted = extractText(candidate);
      if (extracted) return extracted;
    }
  }
  return "";
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, candidate: unknown) => {
        if (typeof candidate === "bigint") return candidate.toString();
        if (typeof candidate !== "object" || candidate === null) return candidate;
        if (seen.has(candidate)) return "[Circular]";
        seen.add(candidate);
        return candidate;
      },
      2,
    );
  } catch {
    return String(value);
  }
}

function requireText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} must not be empty`);
  return text;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
