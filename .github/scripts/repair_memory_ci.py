from pathlib import Path


def replace_once(path_string: str, old: str, new: str) -> None:
    path = Path(path_string)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"marker not found in {path_string}: {old[:160]!r}")
    path.write_text(text.replace(old, new, 1))


def remove_once(path_string: str, block: str) -> None:
    replace_once(path_string, block, "")


# Keep the model protocol as one schema-derived discriminated union. A nested
# Type.Union was accepted at runtime but lost set_status from Static<...>.
tool_protocol = Path("modules/phenix-pi/domain/memory/tool-protocol.ts")
tool_protocol.write_text(
    '''import { type Static, Type } from "typebox";
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

const SetStatusSchemas = [
  Type.Object(
    {
      action: Type.Literal("set_status"),
      noteId: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Literal("active"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("set_status"),
      noteId: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Literal("superseded"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("set_status"),
      noteId: Type.String({ minLength: 1, maxLength: 160 }),
      status: Type.Literal("uncertain"),
    },
    { additionalProperties: false },
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
] as const;

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
  ...SetStatusSchemas,
]);

export type MemoryToolRequest = Static<typeof MEMORY_TOOL_PARAMETERS>;

export function parseMemoryToolRequest(value: unknown): MemoryToolRequest {
  if (Check(MEMORY_TOOL_PARAMETERS, value)) return value as MemoryToolRequest;
  const issues = [...Errors(MEMORY_TOOL_PARAMETERS, value)]
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid phenix_memory request: ${issues || "schema mismatch"}`);
}
'''
)

model = "modules/phenix-pi/domain/memory/model.ts"
replace_once(
    model,
    '''export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly health: MemoryHealthSnapshot;
  readonly evidence: readonly EvidenceRecord[];
''',
    '''export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly health: MemoryHealthSnapshot;
  readonly telemetry: MemoryRuntimeTelemetry;
  readonly evidence: readonly EvidenceRecord[];
''',
)

repository = "modules/phenix-pi/adapters/persistence/jsonl-memory-repository.ts"
replace_once(
    repository,
    '''  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    const sizeBytes = Buffer.byteLength(content, "utf8");
''',
    '''  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {
    const current = await this.load(record.rootRunId);
    if (current.issues.length > 0) {
      throw new Error("Memory ledger requires repair before evidence can be appended");
    }
    const sizeBytes = Buffer.byteLength(content, "utf8");
''',
)
replace_once(
    repository,
    '''    const persisted = await this.load(rootRunId);
    const current = new Map(persisted.notes.map((note) => [note.id, note]));
''',
    '''    const persisted = await this.load(rootRunId);
    if (persisted.issues.length > 0) {
      throw new Error("Memory ledger requires repair before notes can be appended");
    }
    const current = new Map(persisted.notes.map((note) => [note.id, note]));
''',
)
replace_once(
    repository,
    '      writable: stateValue === "healthy" || stateValue === "degraded",\n',
    '      writable: stateValue === "healthy",\n',
)
replace_once(
    repository,
    '''    if (verifyEvidence) {
      for (const record of state.evidence) {
        const content = await this.readPayload(this.evidencePath(rootRunId, record.contentHash));
        if (content === undefined) {
          issues.push({
            kind: "evidence-missing",
            evidenceId: record.id,
            contentHash: record.contentHash,
          });
          continue;
        }
        const issue = payloadIssue(record, content);
        if (issue) issues.push(issue);
        else verifiedEvidenceCount += 1;
      }
    }
''',
    '''    if (verifyEvidence) {
      try {
        for (const record of state.evidence) {
          const content = await this.readPayload(this.evidencePath(rootRunId, record.contentHash));
          if (content === undefined) {
            issues.push({
              kind: "evidence-missing",
              evidenceId: record.id,
              contentHash: record.contentHash,
            });
            continue;
          }
          const issue = payloadIssue(record, content);
          if (issue) issues.push(issue);
          else verifiedEvidenceCount += 1;
        }
      } catch (error) {
        issues.push({
          kind: "repository-unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
''',
)

service = "modules/phenix-pi/application/memory-service.ts"
replace_once(
    service,
    'import { createHash } from "node:crypto";\n\n',
    'import { createHash } from "node:crypto";\n\nimport { MemorySearchIndex, normalizeMemoryTerms } from "./memory-search-index.ts";\n',
)
replace_once(
    service,
    "  type MemoryRepairResult,\n  type MemoryRetention,\n",
    "  type MemoryRepairResult,\n  type MemoryRetention,\n  type MemoryRuntimeTelemetry,\n",
)
replace_once(
    service,
    '''  readonly evidenceByToolCall: Map<string, EvidenceId>;
  readonly issues: readonly MemoryIntegrityIssue[];
''',
    '''  readonly evidenceByToolCall: Map<string, EvidenceId>;
  readonly searchIndex: MemorySearchIndex;
  readonly issues: readonly MemoryIntegrityIssue[];
''',
)
replace_once(
    service,
    "  private readonly roots = new Map<RunId, RootMemoryState>();\n",
    "  private readonly roots = new Map<RunId, RootMemoryState>();\n  private readonly telemetryByRoot = new Map<RunId, MutableMemoryTelemetry>();\n",
)
replace_once(
    service,
    '''      this.emit();
      return evidence;
    });
  }

  async recordNote''',
    '''      this.incrementTelemetry(rootRunId, "toolResultsCaptured");
      this.emit();
      return evidence;
    });
  }

  async recordNote''',
)
replace_once(
    service,
    '''    const content = await this.repository.readEvidence(evidence);
    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);
    return { evidence, content };
''',
    '''    const content = await this.repository.readEvidence(evidence);
    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);
    this.incrementTelemetry(rootRunId, "evidenceReads");
    this.incrementTelemetry(rootRunId, "evidenceReadBytes", Buffer.byteLength(content, "utf8"));
    return { evidence, content };
''',
)
replace_once(
    service,
    '''    const queryTerms = normalizeTerms(input.query);
    const limit = Math.max(
''',
    '''    const queryTerms = normalizeMemoryTerms(input.query);
    const candidates = state.searchIndex.candidates(queryTerms);
    this.incrementTelemetry(rootRunId, "searchRequests");
    const limit = Math.max(
''',
)
replace_once(
    service,
    '''    return [...state.notes.values()]
      .filter((note) => !input.kind || note.kind === input.kind)
''',
    '''    return [...state.notes.values()]
      .filter((note) => !candidates || candidates.has(note.id))
      .filter((note) => !input.kind || note.kind === input.kind)
''',
)
replace_once(
    service,
    '''      health: healthFromAvailable(rootRunId, state),
      evidence,
''',
    '''      health: healthFromAvailable(rootRunId, state),
      telemetry: this.telemetry(rootRunId),
      evidence,
''',
)
replace_once(
    service,
    '''  async health(rootRunId: RunId, verifyEvidence = false): Promise<MemoryHealthSnapshot> {
''',
    '''  telemetry(rootRunId: RunId): MemoryRuntimeTelemetry {
    return { ...this.mutableTelemetry(rootRunId) };
  }

  recordContextAssembly(input: {
    readonly runId: RunId;
    readonly folded: boolean;
    readonly aggressive: boolean;
    readonly foldedToolResults: number;
  }): void {
    const rootRunId = this.rootFor(input.runId);
    this.incrementTelemetry(rootRunId, "contextAssemblies");
    if (input.folded) this.incrementTelemetry(rootRunId, "foldedContexts");
    if (input.aggressive) this.incrementTelemetry(rootRunId, "aggressiveContexts");
    this.incrementTelemetry(rootRunId, "foldedToolResults", input.foldedToolResults);
  }

  async health(rootRunId: RunId, verifyEvidence = false): Promise<MemoryHealthSnapshot> {
''',
)
replace_once(
    service,
    '''      const health =
        state.kind === "available" ? healthFromAvailable(rootRunId, state) : state.health;
      if (result.repaired) {
''',
    '''      const health =
        state.kind === "available" ? healthFromAvailable(rootRunId, state) : state.health;
      this.incrementTelemetry(rootRunId, "repairRuns");
      if (result.repaired) {
''',
)
replace_once(
    service,
    '''  async reportFailure(runId: RunId, operation: MemoryOperation, error: unknown): Promise<void> {
    const rootRunId = this.rootFor(runId);
    try {
''',
    '''  async reportFailure(runId: RunId, operation: MemoryOperation, error: unknown): Promise<void> {
    const rootRunId = this.rootFor(runId);
    this.incrementTelemetry(rootRunId, "operationFailures");
    try {
''',
)
replace_once(
    service,
    '''    this.listeners.clear();
    this.roots.clear();
''',
    '''    this.listeners.clear();
    this.roots.clear();
    this.telemetryByRoot.clear();
''',
)
replace_once(
    service,
    '''        ),
        issues: persisted.issues,
''',
    '''        ),
        searchIndex: new MemorySearchIndex(persisted.notes),
        issues: persisted.issues,
''',
)
replace_once(
    service,
    '''    const result = await this.repository.maintain(rootRunId, this.clock.now());
    this.roots.delete(rootRunId);
''',
    '''    const result = await this.repository.maintain(rootRunId, this.clock.now());
    this.incrementTelemetry(rootRunId, "maintenanceRuns");
    this.roots.delete(rootRunId);
''',
)
replace_once(service, "      fields: result,\n", "      fields: { result },\n")
replace_once(
    service,
    '''    await this.repository.appendNotes(notes);
    for (const note of notes) state.notes.set(note.id, note);
''',
    '''    await this.repository.appendNotes(notes);
    for (const note of notes) {
      state.notes.set(note.id, note);
      state.searchIndex.upsert(note);
    }
''',
)
replace_once(
    service,
    '''      await this.persistNotes(state, [note]);
      this.emit();
    });
  }

  private objectiveScope''',
    '''      await this.persistNotes(state, [note]);
      this.incrementTelemetry(rootRunId, "domainEventsCaptured");
      this.emit();
    });
  }

  private mutableTelemetry(rootRunId: RunId): MutableMemoryTelemetry {
    const existing = this.telemetryByRoot.get(rootRunId);
    if (existing) return existing;
    const created = emptyTelemetry();
    this.telemetryByRoot.set(rootRunId, created);
    return created;
  }

  private incrementTelemetry(
    rootRunId: RunId,
    field: keyof MutableMemoryTelemetry,
    amount = 1,
  ): void {
    const telemetry = this.mutableTelemetry(rootRunId);
    telemetry[field] += amount;
  }

  private objectiveScope''',
)
replace_once(service, "      fields: health,\n", "      fields: { health },\n")
replace_once(
    service,
    '    writable: status === "healthy" || status === "degraded",\n',
    '    writable: status === "healthy",\n',
)
replace_once(
    service,
    '''function emptySnapshot(rootRunId: RunId, health: MemoryHealthSnapshot): MemorySnapshot {
  return {
    rootRunId,
    health,
    evidence: [],
''',
    '''interface MutableMemoryTelemetry {
  toolResultsCaptured: number;
  domainEventsCaptured: number;
  contextAssemblies: number;
  foldedContexts: number;
  aggressiveContexts: number;
  foldedToolResults: number;
  searchRequests: number;
  evidenceReads: number;
  evidenceReadBytes: number;
  operationFailures: number;
  repairRuns: number;
  maintenanceRuns: number;
}

function emptyTelemetry(): MutableMemoryTelemetry {
  return {
    toolResultsCaptured: 0,
    domainEventsCaptured: 0,
    contextAssemblies: 0,
    foldedContexts: 0,
    aggressiveContexts: 0,
    foldedToolResults: 0,
    searchRequests: 0,
    evidenceReads: 0,
    evidenceReadBytes: 0,
    operationFailures: 0,
    repairRuns: 0,
    maintenanceRuns: 0,
  };
}

function emptySnapshot(rootRunId: RunId, health: MemoryHealthSnapshot): MemorySnapshot {
  return {
    rootRunId,
    health,
    telemetry: emptyTelemetry(),
    evidence: [],
''',
)
remove_once(
    service,
    '''function normalizeTerms(query: string | undefined): readonly string[] {
  if (!query?.trim()) return [];
  return [...new Set(query.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])];
}

''',
)

session = "modules/phenix-pi/adapters/pi-sdk/memory-session-extension.ts"
replace_once(
    session,
    '''    case "snapshot": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.snapshot(workingSet.rootRunId);
    }
    case "health": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.health(workingSet.rootRunId, request.verifyEvidence ?? false);
    }
''',
    '''    case "snapshot": {
      const workingSet = await memory.workingSet(runId, 1);
      const snapshot = await memory.snapshot(workingSet.rootRunId);
      return {
        rootRunId: snapshot.rootRunId,
        health: boundedHealth(snapshot.health),
        telemetry: snapshot.telemetry,
        stats: snapshot.stats,
        recentNotes: snapshot.notes.slice(0, 20),
        recentEvidence: snapshot.evidence.slice(0, 20),
        omittedNoteCount: Math.max(0, snapshot.notes.length - 20),
        omittedEvidenceCount: Math.max(0, snapshot.evidence.length - 20),
      };
    }
    case "health": {
      const workingSet = await memory.workingSet(runId, 1);
      return boundedHealth(
        await memory.health(workingSet.rootRunId, request.verifyEvidence ?? false),
      );
    }
''',
)
replace_once(
    session,
    '''  const transformed = folded
    ? await foldToolResults(
        memory,
        runId,
        messages,
        aggressive ? policy.aggressiveMessageTail : policy.recentMessageTail,
      )
    : [...messages];

  if (!canvas) return transformed;
''',
    '''  const foldResult = folded
    ? await foldToolResults(
        memory,
        runId,
        messages,
        aggressive ? policy.aggressiveMessageTail : policy.recentMessageTail,
      )
    : { messages: [...messages], foldedToolResults: 0 };
  memory.recordContextAssembly({
    runId,
    folded,
    aggressive,
    foldedToolResults: foldResult.foldedToolResults,
  });
  const transformed = foldResult.messages;

  if (!canvas) return transformed;
''',
)
replace_once(
    session,
    '''async function foldToolResults(
  memory: MemoryService,
  runId: RunId,
  messages: readonly AgentMessage[],
  protectedTail: number,
): Promise<AgentMessage[]> {
  const tailStart = Math.max(0, messages.length - protectedTail);
  return Promise.all(
    messages.map(async (message, index) => {
      if (index >= tailStart || !isToolResultMessage(message)) return message;
      const evidence = await memory.evidenceForToolCall(runId, message.toolCallId);
      if (!evidence) return message;
      return {
        ...message,
        content: [
          {
            type: "text" as const,
            text:
              `[Folded tool result]\\n${evidence.preview}\\n` +
              `Exact evidence: ${evidence.id}. Use phenix_memory action=read evidenceId=${evidence.id}.`,
          },
        ],
      } as AgentMessage;
    }),
  );
}
''',
    '''async function foldToolResults(
  memory: MemoryService,
  runId: RunId,
  messages: readonly AgentMessage[],
  protectedTail: number,
): Promise<{ readonly messages: AgentMessage[]; readonly foldedToolResults: number }> {
  const tailStart = Math.max(0, messages.length - protectedTail);
  let foldedToolResults = 0;
  const transformed = await Promise.all(
    messages.map(async (message, index) => {
      if (index >= tailStart || !isToolResultMessage(message)) return message;
      const evidence = await memory.evidenceForToolCall(runId, message.toolCallId);
      if (!evidence) return message;
      foldedToolResults += 1;
      return {
        ...message,
        content: [
          {
            type: "text" as const,
            text:
              `[Folded tool result]\\n${evidence.preview}\\n` +
              `Exact evidence: ${evidence.id}. Use phenix_memory action=read evidenceId=${evidence.id}.`,
          },
        ],
      } as AgentMessage;
    }),
  );
  return { messages: transformed, foldedToolResults };
}
''',
)
replace_once(
    session,
    "interface Utf8Page {\n",
    '''function boundedHealth(health: Awaited<ReturnType<MemoryService["health"]>>) {
  return {
    ...health,
    issues: health.issues.slice(0, 50),
    omittedIssueCount: Math.max(0, health.issues.length - 50),
  };
}

interface Utf8Page {
''',
)

context_test = "modules/phenix-pi/tests/memory-context.test.ts"
replace_once(
    context_test,
    '''function memoryStub(): MemoryService {
  return {
    policy: defaultMemoryPolicy,
    workingSet: async () => WORKING_SET,
''',
    '''function memoryStub(): MemoryService {
  return {
    policy: defaultMemoryPolicy,
    recordContextAssembly: () => undefined,
    workingSet: async () => WORKING_SET,
''',
)

repository_test = "modules/phenix-pi/tests/memory-repository.test.ts"
replace_once(
    repository_test,
    '''): MemoryNote {
  return {
''',
    '''): Extract<MemoryNote, { readonly status: "active" }> {
  return {
''',
)

index_test = "modules/phenix-pi/tests/memory-search-index.test.ts"
replace_once(
    index_test,
    '''function note(id: string, summary: string, status: MemoryNote["status"] = "active"): MemoryNote {
  return {
''',
    '''function note(
  id: string,
  summary: string,
): Extract<MemoryNote, { readonly status: "active" }> {
  return {
''',
)
replace_once(index_test, "    status,\n", '    status: "active",\n')
replace_once(
    index_test,
    '  const original = note("memory-status", "Canonical interface", "active");\n',
    '  const original = note("memory-status", "Canonical interface");\n',
)

# The workspace and inspector consume snapshots structurally; make the explicit
# test fixture include the new required telemetry rather than hiding it behind a cast.
workspace_test = "modules/phenix-pi/tests/workspace-view-registry.test.ts"
workspace_text = Path(workspace_test).read_text()
needle = '''      health: {
        rootRunId: "root",
'''
if needle in workspace_text and "toolResultsCaptured" not in workspace_text:
    telemetry = '''      telemetry: {
        toolResultsCaptured: 0,
        domainEventsCaptured: 0,
        contextAssemblies: 0,
        foldedContexts: 0,
        aggressiveContexts: 0,
        foldedToolResults: 0,
        searchRequests: 0,
        evidenceReads: 0,
        evidenceReadBytes: 0,
        operationFailures: 0,
        repairRuns: 0,
        maintenanceRuns: 0,
      },
'''
    workspace_text = workspace_text.replace(needle, telemetry + needle, 1)
    Path(workspace_test).write_text(workspace_text)

# Keep operational docs aligned with the actual read-only degraded state.
docs = Path("docs/MEMORY.md")
docs_text = docs.read_text()
docs_text = docs_text.replace(
    "- **available**: healthy or recoverably degraded and writable;",
    "- **available**: healthy and writable;",
)
docs_text = docs_text.replace(
    "- **unavailable**: corrupt or inaccessible and read-only.",
    "- **unavailable**: degraded, corrupt, or inaccessible and read-only until explicit recovery.",
)
docs_text = docs_text.replace(
    "- `degraded`: only a recoverable incomplete final JSONL line;",
    "- `degraded`: only a recoverable incomplete final JSONL line; read-only until repair;",
)
docs.write_text(docs_text)
