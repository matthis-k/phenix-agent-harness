from pathlib import Path


def replace_once(path_str: str, old: str, new: str) -> None:
    path = Path(path_str)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"marker not found in {path_str}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


service = "modules/phenix-pi/application/memory-service.ts"

replace_once(
    service,
    'import { createHash } from "node:crypto";\n\n',
    'import { createHash } from "node:crypto";\n\n'
    'import { MemorySearchIndex, normalizeMemoryTerms } from "./memory-search-index.ts";\n',
)
replace_once(
    service,
    "  type MemoryRepairResult,\n  type MemoryRetention,\n",
    "  type MemoryRepairResult,\n  type MemoryRetention,\n  type MemoryRuntimeTelemetry,\n",
)
replace_once(
    service,
    "  readonly evidenceByToolCall: Map<string, EvidenceId>;\n"
    "  readonly issues: readonly MemoryIntegrityIssue[];\n",
    "  readonly evidenceByToolCall: Map<string, EvidenceId>;\n"
    "  readonly searchIndex: MemorySearchIndex;\n"
    "  readonly issues: readonly MemoryIntegrityIssue[];\n",
)
replace_once(
    service,
    "  private readonly roots = new Map<RunId, RootMemoryState>();\n",
    "  private readonly roots = new Map<RunId, RootMemoryState>();\n"
    "  private readonly telemetryByRoot = new Map<RunId, MutableMemoryTelemetry>();\n",
)
replace_once(
    service,
    "      this.emit();\n      return evidence;\n    });\n  }\n\n  async recordNote",
    "      this.incrementTelemetry(rootRunId, \"toolResultsCaptured\");\n"
    "      this.emit();\n"
    "      return evidence;\n"
    "    });\n"
    "  }\n\n"
    "  async recordNote",
)
replace_once(
    service,
    "    const content = await this.repository.readEvidence(evidence);\n"
    "    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);\n"
    "    return { evidence, content };\n",
    "    const content = await this.repository.readEvidence(evidence);\n"
    "    if (content === undefined) throw new Error(`Evidence payload is unavailable: ${id}`);\n"
    "    this.incrementTelemetry(rootRunId, \"evidenceReads\");\n"
    "    this.incrementTelemetry(rootRunId, \"evidenceReadBytes\", Buffer.byteLength(content, \"utf8\"));\n"
    "    return { evidence, content };\n",
)
replace_once(
    service,
    "    const queryTerms = normalizeTerms(input.query);\n    const limit = Math.max(\n",
    "    const queryTerms = normalizeMemoryTerms(input.query);\n"
    "    const candidates = state.searchIndex.candidates(queryTerms);\n"
    "    this.incrementTelemetry(rootRunId, \"searchRequests\");\n"
    "    const limit = Math.max(\n",
)
replace_once(
    service,
    "    return [...state.notes.values()]\n"
    "      .filter((note) => !input.kind || note.kind === input.kind)\n",
    "    return [...state.notes.values()]\n"
    "      .filter((note) => !candidates || candidates.has(note.id))\n"
    "      .filter((note) => !input.kind || note.kind === input.kind)\n",
)
replace_once(
    service,
    "      health: healthFromAvailable(rootRunId, state),\n      evidence,\n",
    "      health: healthFromAvailable(rootRunId, state),\n"
    "      telemetry: this.telemetry(rootRunId),\n"
    "      evidence,\n",
)
replace_once(
    service,
    "  async health(rootRunId: RunId, verifyEvidence = false): Promise<MemoryHealthSnapshot> {\n",
    "  telemetry(rootRunId: RunId): MemoryRuntimeTelemetry {\n"
    "    return { ...this.mutableTelemetry(rootRunId) };\n"
    "  }\n\n"
    "  recordContextAssembly(input: {\n"
    "    readonly runId: RunId;\n"
    "    readonly folded: boolean;\n"
    "    readonly aggressive: boolean;\n"
    "    readonly foldedToolResults: number;\n"
    "  }): void {\n"
    "    const rootRunId = this.rootFor(input.runId);\n"
    "    this.incrementTelemetry(rootRunId, \"contextAssemblies\");\n"
    "    if (input.folded) this.incrementTelemetry(rootRunId, \"foldedContexts\");\n"
    "    if (input.aggressive) this.incrementTelemetry(rootRunId, \"aggressiveContexts\");\n"
    "    this.incrementTelemetry(rootRunId, \"foldedToolResults\", input.foldedToolResults);\n"
    "  }\n\n"
    "  async health(rootRunId: RunId, verifyEvidence = false): Promise<MemoryHealthSnapshot> {\n",
)
replace_once(
    service,
    "      if (result.repaired) {\n        await this.diagnostics.record({\n",
    "      this.incrementTelemetry(rootRunId, \"repairRuns\");\n"
    "      if (result.repaired) {\n"
    "        await this.diagnostics.record({\n",
)
replace_once(
    service,
    "    try {\n      await this.diagnostics.record({\n",
    "    this.incrementTelemetry(rootRunId, \"operationFailures\");\n"
    "    try {\n"
    "      await this.diagnostics.record({\n",
)
replace_once(
    service,
    "    this.listeners.clear();\n    this.roots.clear();\n",
    "    this.listeners.clear();\n"
    "    this.roots.clear();\n"
    "    this.telemetryByRoot.clear();\n",
)
replace_once(
    service,
    "          ),\n        ),\n        issues: persisted.issues,\n",
    "          ),\n"
    "        ),\n"
    "        searchIndex: new MemorySearchIndex(persisted.notes),\n"
    "        issues: persisted.issues,\n",
)
replace_once(
    service,
    "    const result = await this.repository.maintain(rootRunId, this.clock.now());\n",
    "    const result = await this.repository.maintain(rootRunId, this.clock.now());\n"
    "    this.incrementTelemetry(rootRunId, \"maintenanceRuns\");\n",
)
replace_once(
    service,
    "    await this.repository.appendNotes(notes);\n"
    "    for (const note of notes) state.notes.set(note.id, note);\n",
    "    await this.repository.appendNotes(notes);\n"
    "    for (const note of notes) {\n"
    "      state.notes.set(note.id, note);\n"
    "      state.searchIndex.upsert(note);\n"
    "    }\n",
)
replace_once(
    service,
    "      await this.persistNotes(state, [note]);\n"
    "      this.emit();\n"
    "    });\n"
    "  }\n\n"
    "  private objectiveScope",
    "      await this.persistNotes(state, [note]);\n"
    "      this.incrementTelemetry(rootRunId, \"domainEventsCaptured\");\n"
    "      this.emit();\n"
    "    });\n"
    "  }\n\n"
    "  private mutableTelemetry(rootRunId: RunId): MutableMemoryTelemetry {\n"
    "    const existing = this.telemetryByRoot.get(rootRunId);\n"
    "    if (existing) return existing;\n"
    "    const created = emptyTelemetry();\n"
    "    this.telemetryByRoot.set(rootRunId, created);\n"
    "    return created;\n"
    "  }\n\n"
    "  private incrementTelemetry(\n"
    "    rootRunId: RunId,\n"
    "    field: keyof MutableMemoryTelemetry,\n"
    "    amount = 1,\n"
    "  ): void {\n"
    "    const telemetry = this.mutableTelemetry(rootRunId);\n"
    "    telemetry[field] += amount;\n"
    "  }\n\n"
    "  private objectiveScope",
)
replace_once(
    service,
    "function emptySnapshot(rootRunId: RunId, health: MemoryHealthSnapshot): MemorySnapshot {\n"
    "  return {\n"
    "    rootRunId,\n"
    "    health,\n"
    "    evidence: [],\n",
    "interface MutableMemoryTelemetry {\n"
    "  toolResultsCaptured: number;\n"
    "  domainEventsCaptured: number;\n"
    "  contextAssemblies: number;\n"
    "  foldedContexts: number;\n"
    "  aggressiveContexts: number;\n"
    "  foldedToolResults: number;\n"
    "  searchRequests: number;\n"
    "  evidenceReads: number;\n"
    "  evidenceReadBytes: number;\n"
    "  operationFailures: number;\n"
    "  repairRuns: number;\n"
    "  maintenanceRuns: number;\n"
    "}\n\n"
    "function emptyTelemetry(): MutableMemoryTelemetry {\n"
    "  return {\n"
    "    toolResultsCaptured: 0,\n"
    "    domainEventsCaptured: 0,\n"
    "    contextAssemblies: 0,\n"
    "    foldedContexts: 0,\n"
    "    aggressiveContexts: 0,\n"
    "    foldedToolResults: 0,\n"
    "    searchRequests: 0,\n"
    "    evidenceReads: 0,\n"
    "    evidenceReadBytes: 0,\n"
    "    operationFailures: 0,\n"
    "    repairRuns: 0,\n"
    "    maintenanceRuns: 0,\n"
    "  };\n"
    "}\n\n"
    "function emptySnapshot(rootRunId: RunId, health: MemoryHealthSnapshot): MemorySnapshot {\n"
    "  return {\n"
    "    rootRunId,\n"
    "    health,\n"
    "    telemetry: emptyTelemetry(),\n"
    "    evidence: [],\n",
)

service_path = Path(service)
service_text = service_path.read_text()
normalizer_start = service_text.find(
    "function normalizeTerms(query: string | undefined): readonly string[] {"
)
if normalizer_start != -1:
    normalizer_end = service_text.find("\n}\n", normalizer_start)
    if normalizer_end == -1:
        raise SystemExit("normalizeTerms terminator not found")
    service_text = service_text[:normalizer_start] + service_text[normalizer_end + 3 :]
service_path.write_text(service_text)

context_path = "modules/phenix-pi/adapters/pi-sdk/memory-session-extension.ts"
replace_once(
    context_path,
    """  const transformed = folded
    ? await foldToolResults(
        memory,
        runId,
        messages,
        aggressive ? policy.aggressiveMessageTail : policy.recentMessageTail,
      )
    : [...messages];

  if (!canvas) return transformed;
""",
    """  const foldResult = folded
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
""",
)
replace_once(
    context_path,
    """async function foldToolResults(
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
""",
    """async function foldToolResults(
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
""",
)

context_test = "modules/phenix-pi/tests/memory-context.test.ts"
replace_once(
    context_test,
    "  const memory = memoryStub();\n  const messages = [\n",
    "  const telemetry: Array<{\n"
    "    readonly folded: boolean;\n"
    "    readonly aggressive: boolean;\n"
    "    readonly foldedToolResults: number;\n"
    "  }> = [];\n"
    "  const memory = memoryStub(telemetry);\n"
    "  const messages = [\n",
)
replace_once(
    context_test,
    """  assert.equal(
    assembled.filter((message) => message.role === "assistant").length,
    messages.filter((message) => message.role === "assistant").length,
  );
});
""",
    """  assert.equal(
    assembled.filter((message) => message.role === "assistant").length,
    messages.filter((message) => message.role === "assistant").length,
  );
  assert.deepEqual(telemetry, [{ folded: true, aggressive: true, foldedToolResults: 1 }]);
});
""",
)
replace_once(
    context_test,
    """function memoryStub(): MemoryService {
  return {
    policy: defaultMemoryPolicy,
    workingSet: async () => WORKING_SET,
""",
    """function memoryStub(
  telemetry: Array<{
    readonly folded: boolean;
    readonly aggressive: boolean;
    readonly foldedToolResults: number;
  }> = [],
): MemoryService {
  return {
    policy: defaultMemoryPolicy,
    recordContextAssembly: (input: {
      readonly folded: boolean;
      readonly aggressive: boolean;
      readonly foldedToolResults: number;
    }) => {
      telemetry.push(input);
    },
    workingSet: async () => WORKING_SET,
""",
)

workspace_test = "modules/phenix-pi/tests/workspace-view-registry.test.ts"
replace_once(
    workspace_test,
    "      evidence: [],\n      notes: [\n",
    "      telemetry: {\n"
    "        toolResultsCaptured: 0,\n"
    "        domainEventsCaptured: 0,\n"
    "        contextAssemblies: 3,\n"
    "        foldedContexts: 2,\n"
    "        aggressiveContexts: 1,\n"
    "        foldedToolResults: 4,\n"
    "        searchRequests: 0,\n"
    "        evidenceReads: 0,\n"
    "        evidenceReadBytes: 0,\n"
    "        operationFailures: 0,\n"
    "        repairRuns: 0,\n"
    "        maintenanceRuns: 0,\n"
    "      },\n"
    "      evidence: [],\n"
    "      notes: [\n",
)

extension = "modules/phenix-pi/extension/memory-extension.ts"
replace_once(
    extension,
    "    `Current evidence bytes: ${snapshot.stats.storedBytes}`,\n"
    '    "",\n'
    '    "Notes:",\n',
    "    `Current evidence bytes: ${snapshot.stats.storedBytes}`,\n"
    '    "",\n'
    '    "Runtime telemetry:",\n'
    "    JSON.stringify(snapshot.telemetry, undefined, 2),\n"
    '    "",\n'
    '    "Notes:",\n',
)

service_test = "modules/phenix-pi/tests/memory-service.test.ts"
replace_once(
    service_test,
    "  assert.equal(repository.evidence.size, 2);\n\n  memory.shutdown();\n",
    "  assert.equal(repository.evidence.size, 2);\n"
    "  assert.equal(memory.telemetry(ROOT).toolResultsCaptured, 2);\n\n"
    "  memory.shutdown();\n",
)
replace_once(
    service_test,
    "  readonly noteBatches: readonly MemoryNote[][] = [];\n",
    "  readonly noteBatches: MemoryNote[][] = [];\n",
)
replace_once(
    service_test,
    "    (this.noteBatches as MemoryNote[][]).push([...notes]);\n",
    "    this.noteBatches.push([...notes]);\n",
)

docs = Path("docs/MEMORY.md")
docs_text = docs.read_text()
old = """Evidence is authoritative. Notes and injected context are indexes into evidence, not substitutes for
it.
"""
new = """Evidence is authoritative. Notes and injected context are indexes into evidence, not substitutes for
it. Search uses a deterministic in-memory inverted index rebuilt from typed persisted notes at root
load. The index is updated with each atomic note batch and is never a second persistence authority.
"""
if old not in docs_text:
    raise SystemExit("docs evidence marker not found")
docs_text = docs_text.replace(old, new, 1)
old = """The Memory workspace pane begins with a health row showing state, writability, note/evidence counts,
stored bytes, and issue classes. Notes follow in validity order.
"""
new = """The Memory workspace pane begins with a health row showing state, writability, note/evidence counts,
stored bytes, and issue classes. Notes follow in validity order. Memory snapshots and session
manifests include typed runtime telemetry for capture, context assembly, folding, indexed search,
evidence reads, failures, repair, and maintenance.
"""
if old not in docs_text:
    raise SystemExit("docs UI marker not found")
docs.write_text(docs_text.replace(old, new, 1))
