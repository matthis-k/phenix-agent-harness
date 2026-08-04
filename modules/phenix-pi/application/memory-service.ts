import { createHash } from "node:crypto";

import {
  type EvidenceId,
  type EvidenceRecord,
  type EvidenceSource,
  evidenceId,
  type MemoryHealthSnapshot,
  type MemoryIntegrityIssue,
  type MemoryKind,
  type MemoryMaintenanceResult,
  type MemoryNote,
  type MemoryNoteId,
  type MemoryReliability,
  type MemoryRepairResult,
  type MemoryRetention,
  type MemorySnapshot,
  type MemoryStatus,
  memoryNoteId,
  type WorkingMemoryProjection,
} from "../domain/memory/model.ts";
import type { MemoryPolicy } from "../domain/memory/policy.ts";
import { focusedObjectiveId } from "../domain/objective/projection.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import type { RunFactRecordedData } from "../domain/run/observability.ts";
import type { ObjectiveId, RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";
import type { DiagnosticLog } from "../ports/diagnostic-log.ts";
import type { MemoryRepository, PersistedMemoryState } from "../ports/memory-repository.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

interface AvailableRootMemoryState {
  readonly kind: "available";
  readonly evidence: Map<EvidenceId, EvidenceRecord>;
  readonly notes: Map<MemoryNoteId, MemoryNote>;
  readonly evidenceByToolCall: Map<string, EvidenceId>;
  readonly issues: readonly MemoryIntegrityIssue[];
  readonly ledgerBytes: number;
}

interface UnavailableRootMemoryState {
  readonly kind: "unavailable";
  readonly health: MemoryHealthSnapshot;
}

type RootMemoryState = AvailableRootMemoryState | UnavailableRootMemoryState;

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
export type MemoryOperation =
  | "initialize"
  | "capture-tool-result"
  | "capture-domain-event"
  | "assemble-context"
  | "snapshot"
  | "health"
  | "search"
  | "read"
  | "note"
  | "set-status"
  | "repair"
  | "maintain";

export class MemoryUnavailableError extends Error {
  readonly health: MemoryHealthSnapshot;

  constructor(health: MemoryHealthSnapshot) {
    super(`Phenix memory is ${health.state}: ${formatIssues(health.issues)}`);
    this.name = "MemoryUnavailableError";
    this.health = health;
  }
}

export class MemoryService {
  readonly policy: MemoryPolicy;

  private readonly repository: MemoryRepository;
  private readonly store: ExecutionStore;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly diagnostics: DiagnosticLog;
  private readonly roots = new Map<RunId, RootMemoryState>();
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly listeners = new Set<MemoryListener>();
  private readonly unsubscribeEvents: () => void;

  constructor(input: {
    readonly repository: MemoryRepository;
    readonly store: ExecutionStore;
    readonly ids: IdGenerator;
    readonly clock: Clock;
    readonly diagnostics: DiagnosticLog;
    readonly policy: MemoryPolicy;
  }) {
    this.repository = input.repository;
    this.store = input.store;
    this.ids = input.ids;
    this.clock = input.clock;
    this.diagnostics = input.diagnostics;
    this.policy = input.policy;
    this.unsubscribeEvents = this.store.events.subscribe(async (event) => {
      try {
        await this.observeDomainEvent(event);
      } catch (error) {
        await this.reportFailure(event.runId, "capture-domain-event", error);
        if (this.policy.captureFailureMode === "strict") throw error;
      }
    });
  }

  async initializeRoot(rootRunId: RunId): Promise<void> {
    await this.serial.run(rootRunId, async () => {
      const state = await this.loadRoot(rootRunId);
      if (state.kind === "unavailable") {
        await this.recordHealthDiagnostic(state.health);
        if (this.policy.captureFailureMode === "strict") {
          throw new MemoryUnavailableError(state.health);
        }
        return;
      }
      if (state.issues.length > 0) await this.recordHealthDiagnostic(healthFromAvailable(rootRunId, state));
      if (
        this.policy.storage.automaticMaintenance &&
        state.issues.length === 0 &&
        state.ledgerBytes >= this.policy.storage.maintenanceLedgerBytes
      ) {
        await this.maintainAvailable(rootRunId, state);
      }
    });
  }

  subscribe(listener: MemoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async captureToolResult(input: CaptureToolResultInput): Promise<EvidenceRecord> {
    const rootRunId = this.rootFor(input.runId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.requireAvailable(rootRunId);
      const key = toolCallKey(input.runId, input.toolCallId);
      const existingId = state.evidenceByToolCall.get(key);
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
      state.evidenceByToolCall.set(key, evidence.id);

      if (input.toolName !== "phenix_progress") {
        const classification = classifyToolResult(input);
        const note = this.createNote({
          runId: input.runId,
          kind: classification.kind,
          summary,
          ...(classification.subject ? { subject: classification.subject } : {}),
          evidenceIds: [evidence.id],
          retention: classification.retention,
          reliability: "observed",
          status: input.isError ? "uncertain" : "active",
        });
        await this.persistNotes(state, [note]);
      }
      this.emit();
      return evidence;
    });
  }

  async recordNote(input: RecordMemoryNoteInput): Promise<MemoryNote> {
    const rootRunId = this.rootFor(input.runId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.requireAvailable(rootRunId);
      validateUniqueIds(input.evidenceIds ?? [], "memory evidence references");
      validateUniqueIds(input.supersedes ?? [], "memory supersedes references");
      for (const id of input.evidenceIds ?? []) {
        if (!state.evidence.has(id)) throw new Error(`Unknown memory evidence: ${id}`);
      }
      for (const id of input.supersedes ?? []) {
        if (!state.notes.has(id)) throw new Error(`Unknown superseded memory note: ${id}`);
      }

      const note = this.createNote(input);
      const now = this.clock.now();
      const updates: MemoryNote[] = [note];
      for (const previousId of input.supersedes ?? []) {
        const previous = state.notes.get(previousId);
        if (!previous || previous.status === "superseded") continue;
        updates.push(transitionNote(previous, "superseded", now));
      }
      await this.persistNotes(state, updates);
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
    const rootRunId = this.rootFor(actorRunId);
    return this.serial.run(rootRunId, async () => {
      const state = await this.requireAvailable(rootRunId);
      const current = state.notes.get(id);
      if (!current) throw new Error(`Unknown memory note: ${id}`);
      if (status !== "invalidated" && invalidatedBy !== undefined) {
        throw new Error("invalidatedBy is only valid when status is invalidated");
      }
      if (invalidatedBy !== undefined) {
        if (invalidatedBy === id) throw new Error("A memory note cannot invalidate itself");
        if (!state.notes.has(invalidatedBy)) {
          throw new Error(`Unknown invalidating memory note: ${invalidatedBy}`);
        }
      }
      const updated = transitionNote(current, status, this.clock.now(), invalidatedBy);
      await this.persistNotes(state, [updated]);
      this.emit();
      return updated;
    });
  }

  async read(runId: RunId, id: EvidenceId): Promise<MemoryReadResult> {
    const rootRunId = this.rootFor(runId);
    const state = await this.requireAvailable(rootRunId);
    const evidence = state.evidence.get(id);
    if (!evidence) throw new Error(`Unknown evidence: ${id}`);
    const content = await this.repository.readEvidence(evidence);
    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);
    return { evidence, content };
  }

  async search(input: SearchMemoryInput): Promise<readonly MemoryNote[]> {
    const rootRunId = this.rootFor(input.runId);
    const state = await this.requireAvailable(rootRunId);
    const queryTerms = normalizeTerms(input.query);
    const limit = Math.max(
      1,
      Math.min(this.policy.storage.maximumSearchResults, input.limit ?? 20),
    );
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
    const state = await this.ensureState(rootRunId);
    if (state.kind === "unavailable") return emptySnapshot(rootRunId, state.health);
    const evidence = [...state.evidence.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    const notes = [...state.notes.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    return {
      rootRunId,
      health: healthFromAvailable(rootRunId, state),
      evidence,
      notes,
      stats: {
        evidenceCount: evidence.length,
        activeNoteCount: notes.filter((note) => note.status === "active").length,
        storedBytes: evidence.reduce((total, item) => total + item.sizeBytes, 0),
      },
    };
  }

  async health(rootRunId: RunId, verifyEvidence = false): Promise<MemoryHealthSnapshot> {
    return this.serial.run(rootRunId, async () => {
      const current = await this.ensureState(rootRunId);
      if (!verifyEvidence) {
        return current.kind === "available"
          ? healthFromAvailable(rootRunId, current)
          : current.health;
      }
      const inspected = await this.repository.inspect(rootRunId, true);
      if (!inspected.writable) {
        this.roots.set(rootRunId, { kind: "unavailable", health: inspected });
        this.emit();
        return inspected;
      }
      this.roots.delete(rootRunId);
      const reloaded = await this.loadRoot(rootRunId);
      if (reloaded.kind === "unavailable") return reloaded.health;
      return {
        ...healthFromAvailable(rootRunId, reloaded),
        verifiedEvidenceCount: inspected.verifiedEvidenceCount,
      };
    });
  }

  async repair(rootRunId: RunId): Promise<MemoryRepairResult> {
    return this.serial.run(rootRunId, async () => {
      const result = await this.repository.repair(rootRunId);
      this.roots.delete(rootRunId);
      const state = await this.loadRoot(rootRunId);
      const health =
        state.kind === "available" ? healthFromAvailable(rootRunId, state) : state.health;
      if (result.repaired) {
        await this.diagnostics.record({
          rootRunId,
          runId: rootRunId,
          severity: health.writable ? "warning" : "error",
          scope: "memory.persistence.repaired",
          message: "Phenix memory repair completed",
          fields: { result, health },
        });
        this.emit();
      }
      return { ...result, remainingIssues: health.issues };
    });
  }

  async maintain(rootRunId: RunId): Promise<MemoryMaintenanceResult> {
    return this.serial.run(rootRunId, async () => {
      const state = await this.requireAvailable(rootRunId);
      return this.maintainAvailable(rootRunId, state);
    });
  }

  async workingSet(runId: RunId, limit = 24): Promise<WorkingMemoryProjection> {
    const rootRunId = this.rootFor(runId);
    const state = await this.ensureState(rootRunId);
    const objectivePath = this.objectivePath(runId);
    if (state.kind === "unavailable") {
      return { rootRunId, runId, objectivePath, notes: [], recentEvidence: [] };
    }
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
    const rootRunId = this.rootFor(runId);
    const state = await this.ensureState(rootRunId);
    if (state.kind === "unavailable") return undefined;
    const id = state.evidenceByToolCall.get(toolCallKey(runId, toolCallId));
    return id ? state.evidence.get(id) : undefined;
  }

  async reportFailure(runId: RunId, operation: MemoryOperation, error: unknown): Promise<void> {
    const rootRunId = this.rootFor(runId);
    try {
      await this.diagnostics.record({
        rootRunId,
        runId,
        severity: "error",
        scope: `memory.operation.${operation}.failed`,
        message: `Phenix memory ${operation} failed`,
        fields: { error },
      });
    } catch (diagnosticError) {
      console.error(
        `[phenix] memory ${operation} failed and could not be diagnosed:`,
        diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      );
    }
  }

  shutdown(): void {
    this.unsubscribeEvents();
    this.listeners.clear();
    this.roots.clear();
  }

  private async ensureState(rootRunId: RunId): Promise<RootMemoryState> {
    const existing = this.roots.get(rootRunId);
    return existing ?? this.loadRoot(rootRunId);
  }

  private async requireAvailable(rootRunId: RunId): Promise<AvailableRootMemoryState> {
    const state = await this.ensureState(rootRunId);
    if (state.kind === "unavailable") throw new MemoryUnavailableError(state.health);
    return state;
  }

  private async loadRoot(rootRunId: RunId): Promise<RootMemoryState> {
    try {
      const inspected = await this.repository.inspect(rootRunId, false);
      if (!inspected.writable) {
        const unavailable: UnavailableRootMemoryState = { kind: "unavailable", health: inspected };
        this.roots.set(rootRunId, unavailable);
        return unavailable;
      }
      const persisted = await this.repository.load(rootRunId);
      const semanticIssues = semanticMemoryIssues(persisted);
      if (semanticIssues.length > 0) {
        const health: MemoryHealthSnapshot = {
          rootRunId,
          state: "corrupt",
          writable: false,
          issues: [...persisted.issues, ...semanticIssues],
          evidenceCount: persisted.evidence.length,
          noteCount: persisted.notes.length,
          activeNoteCount: persisted.notes.filter((note) => note.status === "active").length,
          storedBytes: persisted.evidence.reduce((total, item) => total + item.sizeBytes, 0),
          ledgerBytes: persisted.ledgerBytes,
          verifiedEvidenceCount: 0,
        };
        const unavailable: UnavailableRootMemoryState = { kind: "unavailable", health };
        this.roots.set(rootRunId, unavailable);
        return unavailable;
      }
      const available: AvailableRootMemoryState = {
        kind: "available",
        evidence: new Map(persisted.evidence.map((item) => [item.id, item])),
        notes: new Map(persisted.notes.map((item) => [item.id, item])),
        evidenceByToolCall: new Map(
          persisted.evidence.flatMap((item) =>
            item.source.kind === "tool-result"
              ? [[toolCallKey(item.runId, item.source.toolCallId), item.id] as const]
              : [],
          ),
        ),
        issues: persisted.issues,
        ledgerBytes: persisted.ledgerBytes,
      };
      this.roots.set(rootRunId, available);
      return available;
    } catch (error) {
      const health = unavailableHealth(rootRunId, error);
      const unavailable: UnavailableRootMemoryState = { kind: "unavailable", health };
      this.roots.set(rootRunId, unavailable);
      return unavailable;
    }
  }

  private async maintainAvailable(
    rootRunId: RunId,
    state: AvailableRootMemoryState,
  ): Promise<MemoryMaintenanceResult> {
    if (state.issues.length > 0) {
      throw new Error("Memory maintenance requires a clean ledger; run repair first");
    }
    const result = await this.repository.maintain(rootRunId, this.clock.now());
    this.roots.delete(rootRunId);
    const reloaded = await this.loadRoot(rootRunId);
    if (reloaded.kind === "unavailable") throw new MemoryUnavailableError(reloaded.health);
    await this.diagnostics.record({
      rootRunId,
      runId: rootRunId,
      severity: "info",
      scope: "memory.persistence.maintained",
      message: "Phenix memory retention and compaction completed",
      fields: result,
    });
    this.emit();
    return result;
  }

  private async persistEvidence(
    state: AvailableRootMemoryState,
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

  private createNote(input: RecordMemoryNoteInput): MemoryNote {
    const now = this.clock.now();
    const base = {
      id: memoryNoteId(this.ids.next("memory")),
      rootRunId: this.rootFor(input.runId),
      runId: input.runId,
      objectiveIds: this.objectiveScope(input.runId),
      kind: input.kind,
      retention: input.retention ?? "summary-sufficient",
      reliability: input.reliability ?? "reported",
      summary: requireText(input.summary, "Memory summary"),
      ...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
      evidenceIds: input.evidenceIds ?? [],
      ...(input.supersedes && input.supersedes.length > 0
        ? { supersedes: input.supersedes }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    const status = input.status ?? "active";
    return status === "invalidated" ? { ...base, status } : { ...base, status };
  }

  private async persistNotes(
    state: AvailableRootMemoryState,
    notes: readonly MemoryNote[],
  ): Promise<void> {
    await this.repository.appendNotes(notes);
    for (const note of notes) state.notes.set(note.id, note);
  }

  private async observeDomainEvent(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "run.fact.recorded": {
        const fact: RunFactRecordedData = event.data;
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
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "run.orphaned": {
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
        return;
      }
      default:
        return;
    }
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
      const state = await this.requireAvailable(rootRunId);
      const content = safeSerialize(input.payload ?? input.event.data);
      const evidence = await this.persistEvidence(state, {
        rootRunId,
        runId: input.event.runId,
        source: input.source ?? { kind: "domain-event", eventId: input.event.eventId },
        content,
        mediaType: "application/json",
        preview: input.summary,
      });
      const note = this.createNote({
        runId: input.event.runId,
        kind: input.kind,
        summary: input.summary,
        ...(input.subject ? { subject: input.subject } : {}),
        evidenceIds: [evidence.id],
        reliability: input.reliability,
        retention: input.retention,
      });
      await this.persistNotes(state, [note]);
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

  private rootFor(runId: RunId): RunId {
    try {
      return this.store.projection.rootOf(runId);
    } catch {
      return runId;
    }
  }

  private async recordHealthDiagnostic(health: MemoryHealthSnapshot): Promise<void> {
    if (health.state === "healthy") return;
    await this.diagnostics.record({
      rootRunId: health.rootRunId,
      runId: health.rootRunId,
      severity: health.state === "degraded" ? "warning" : "error",
      scope: `memory.health.${health.state}`,
      message: `Phenix memory is ${health.state}`,
      fields: health,
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function transitionNote(
  note: MemoryNote,
  status: MemoryStatus,
  updatedAt: string,
  invalidatedBy?: MemoryNoteId,
): MemoryNote {
  const base = {
    id: note.id,
    rootRunId: note.rootRunId,
    runId: note.runId,
    objectiveIds: note.objectiveIds,
    kind: note.kind,
    retention: note.retention,
    reliability: note.reliability,
    summary: note.summary,
    ...(note.subject === undefined ? {} : { subject: note.subject }),
    evidenceIds: note.evidenceIds,
    ...(note.supersedes === undefined ? {} : { supersedes: note.supersedes }),
    createdAt: note.createdAt,
    updatedAt,
  };
  if (status === "invalidated") {
    return {
      ...base,
      status,
      ...(invalidatedBy === undefined ? {} : { invalidatedBy }),
    };
  }
  return { ...base, status };
}

function semanticMemoryIssues(state: PersistedMemoryState): readonly MemoryIntegrityIssue[] {
  const evidence = new Set(state.evidence.map((item) => item.id));
  const notes = new Map(state.notes.map((item) => [item.id, item]));
  const issues: MemoryIntegrityIssue[] = [];
  for (const note of state.notes) {
    for (const id of note.evidenceIds) {
      if (!evidence.has(id)) issues.push({ kind: "note-evidence-missing", noteId: note.id, evidenceId: id });
    }
    for (const id of note.supersedes ?? []) {
      if (id === note.id) {
        issues.push({
          kind: "note-reference-invalid",
          noteId: note.id,
          relation: "supersedes",
          referencedNoteId: id,
          reason: "self-reference",
        });
      } else if (!notes.has(id)) {
        issues.push({
          kind: "note-reference-missing",
          noteId: note.id,
          relation: "supersedes",
          referencedNoteId: id,
        });
      }
    }
    if (note.status === "invalidated" && note.invalidatedBy !== undefined) {
      if (note.invalidatedBy === note.id) {
        issues.push({
          kind: "note-reference-invalid",
          noteId: note.id,
          relation: "invalidatedBy",
          referencedNoteId: note.invalidatedBy,
          reason: "self-reference",
        });
      } else if (!notes.has(note.invalidatedBy)) {
        issues.push({
          kind: "note-reference-missing",
          noteId: note.id,
          relation: "invalidatedBy",
          referencedNoteId: note.invalidatedBy,
        });
      }
    }
  }
  const cycle = findSupersessionCycle(notes);
  if (cycle) issues.push({ kind: "note-supersession-cycle", noteIds: cycle });
  return issues;
}

function findSupersessionCycle(
  notes: ReadonlyMap<MemoryNoteId, MemoryNote>,
): readonly MemoryNoteId[] | undefined {
  const completed = new Set<MemoryNoteId>();
  for (const start of [...notes.keys()].sort()) {
    if (completed.has(start)) continue;
    const path: MemoryNoteId[] = [];
    const positions = new Map<MemoryNoteId, number>();
    const stack: Array<{ readonly id: MemoryNoteId; index: number }> = [{ id: start, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      if (!positions.has(frame.id)) {
        positions.set(frame.id, path.length);
        path.push(frame.id);
      }
      const edges = notes.get(frame.id)?.supersedes ?? [];
      const next = edges[frame.index];
      if (next === undefined) {
        completed.add(frame.id);
        positions.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }
      frame.index += 1;
      const cycleAt = positions.get(next);
      if (cycleAt !== undefined) return [...path.slice(cycleAt), next];
      if (!completed.has(next) && notes.has(next)) stack.push({ id: next, index: 0 });
    }
  }
  return undefined;
}

function healthFromAvailable(
  rootRunId: RunId,
  state: AvailableRootMemoryState,
): MemoryHealthSnapshot {
  const status = healthState(state.issues);
  return {
    rootRunId,
    state: status,
    writable: status === "healthy" || status === "degraded",
    issues: state.issues,
    evidenceCount: state.evidence.size,
    noteCount: state.notes.size,
    activeNoteCount: [...state.notes.values()].filter((note) => note.status === "active").length,
    storedBytes: [...state.evidence.values()].reduce((total, item) => total + item.sizeBytes, 0),
    ledgerBytes: state.ledgerBytes,
    verifiedEvidenceCount: 0,
  };
}

function unavailableHealth(rootRunId: RunId, error: unknown): MemoryHealthSnapshot {
  return {
    rootRunId,
    state: "unavailable",
    writable: false,
    issues: [
      {
        kind: "repository-unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
    evidenceCount: 0,
    noteCount: 0,
    activeNoteCount: 0,
    storedBytes: 0,
    ledgerBytes: 0,
    verifiedEvidenceCount: 0,
  };
}

function emptySnapshot(rootRunId: RunId, health: MemoryHealthSnapshot): MemorySnapshot {
  return {
    rootRunId,
    health,
    evidence: [],
    notes: [],
    stats: { evidenceCount: 0, activeNoteCount: 0, storedBytes: 0 },
  };
}

function healthState(issues: readonly MemoryIntegrityIssue[]): MemoryHealthSnapshot["state"] {
  if (issues.some((issue) => issue.kind === "repository-unavailable")) return "unavailable";
  if (issues.some((issue) => issue.kind !== "ledger-tail-truncated")) return "corrupt";
  return issues.length > 0 ? "degraded" : "healthy";
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
    case "run-started":
    case "run-state-changed":
    case "file-read":
    case "search-performed":
    case "command-finished":
    case "child-started":
    case "child-finished":
    case "workflow-transition":
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
      const extracted = extractText(value[field]);
      if (extracted) return extracted;
    }
  }
  return "";
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key, candidate: unknown) => {
          if (typeof candidate === "bigint") return candidate.toString();
          if (typeof candidate !== "object" || candidate === null) return candidate;
          if (seen.has(candidate)) return "[Circular]";
          seen.add(candidate);
          return candidate;
        },
        2,
      ) ?? String(value)
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

function validateUniqueIds(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

function formatIssues(issues: readonly MemoryIntegrityIssue[]): string {
  return issues.length === 0 ? "no details" : issues.map((issue) => issue.kind).join(", ");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
