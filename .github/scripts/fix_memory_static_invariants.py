from pathlib import Path


def replace_once(path_str: str, old: str, new: str) -> None:
    path = Path(path_str)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"marker not found in {path_str}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


repository = "modules/phenix-pi/adapters/persistence/jsonl-memory-repository.ts"
replace_once(
    repository,
    "  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {\n"
    "    const sizeBytes = Buffer.byteLength(content, \"utf8\");\n",
    "  async appendEvidence(record: EvidenceRecord, content: string): Promise<void> {\n"
    "    const current = await this.load(record.rootRunId);\n"
    "    if (current.issues.length > 0) {\n"
    "      throw new Error(\"Memory ledger requires repair before evidence can be appended\");\n"
    "    }\n"
    "    const sizeBytes = Buffer.byteLength(content, \"utf8\");\n",
)
replace_once(
    repository,
    "    const persisted = await this.load(rootRunId);\n"
    "    const current = new Map(persisted.notes.map((note) => [note.id, note]));\n",
    "    const persisted = await this.load(rootRunId);\n"
    "    if (persisted.issues.length > 0) {\n"
    "      throw new Error(\"Memory ledger requires repair before notes can be appended\");\n"
    "    }\n"
    "    const current = new Map(persisted.notes.map((note) => [note.id, note]));\n",
)
replace_once(
    repository,
    '      writable: stateValue === "healthy" || stateValue === "degraded",\n',
    '      writable: stateValue === "healthy",\n',
)
replace_once(
    repository,
    """    if (verifyEvidence) {
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
""",
    """    if (verifyEvidence) {
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
""",
)

service = "modules/phenix-pi/application/memory-service.ts"
replace_once(
    service,
    '    writable: status === "healthy" || status === "degraded",\n',
    '    writable: status === "healthy",\n',
)
replace_once(
    service,
    '  if (input.isError) return { kind: "error", retention: "structured-lossless", subject: path };\n',
    "  if (input.isError) {\n"
    "    return {\n"
    '      kind: "error",\n'
    '      retention: "structured-lossless",\n'
    "      ...(path === undefined ? {} : { subject: path }),\n"
    "    };\n"
    "  }\n",
)
replace_once(
    service,
    '    return { kind: "change", retention: "structured-lossless", subject: path };\n',
    "    return {\n"
    '      kind: "change",\n'
    '      retention: "structured-lossless",\n'
    "      ...(path === undefined ? {} : { subject: path }),\n"
    "    };\n",
)
replace_once(
    service,
    "      retention: \"structured-lossless\",\n      subject: command,\n",
    "      retention: \"structured-lossless\",\n"
    "      ...(command === undefined ? {} : { subject: command }),\n",
)
replace_once(
    service,
    "    retention: [\"read\", \"grep\", \"find\", \"ls\"].includes(input.toolName)\n"
    "      ? \"summary-sufficient\"\n"
    "      : \"structured-lossless\",\n"
    "    subject: path,\n",
    "    retention: [\"read\", \"grep\", \"find\", \"ls\"].includes(input.toolName)\n"
    "      ? \"summary-sufficient\"\n"
    "      : \"structured-lossless\",\n"
    "    ...(path === undefined ? {} : { subject: path }),\n",
)

tool_protocol = "modules/phenix-pi/domain/memory/tool-protocol.ts"
replace_once(
    tool_protocol,
    "  const issues = Errors(MEMORY_TOOL_PARAMETERS, value)\n"
    "    .slice(0, 8)\n",
    "  const issues = [...Errors(MEMORY_TOOL_PARAMETERS, value)]\n"
    "    .slice(0, 8)\n",
)

docs = Path("docs/MEMORY.md")
text = docs.read_text()
text = text.replace(
    "- **available**: healthy or recoverably degraded and writable;\n"
    "- **unavailable**: corrupt or inaccessible and read-only.\n",
    "- **available**: healthy and writable;\n"
    "- **unavailable**: degraded, corrupt, or inaccessible and read-only until explicit recovery.\n",
)
text = text.replace(
    "- `degraded`: only a recoverable incomplete final JSONL line;\n",
    "- `degraded`: only a recoverable incomplete final JSONL line; read-only until repair;\n",
)
docs.write_text(text)
