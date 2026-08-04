from pathlib import Path


def replace_once(path_str: str, old: str, new: str) -> None:
    path = Path(path_str)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"marker not found in {path_str}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


session = "modules/phenix-pi/adapters/pi-sdk/memory-session-extension.ts"
replace_once(
    session,
    """    case "snapshot": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.snapshot(workingSet.rootRunId);
    }
    case "health": {
      const workingSet = await memory.workingSet(runId, 1);
      return memory.health(workingSet.rootRunId, request.verifyEvidence ?? false);
    }
""",
    """    case "snapshot": {
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
""",
)
replace_once(
    session,
    "interface Utf8Page {\n",
    "function boundedHealth(health: Awaited<ReturnType<MemoryService[\"health\"]>>) {\n"
    "  return {\n"
    "    ...health,\n"
    "    issues: health.issues.slice(0, 50),\n"
    "    omittedIssueCount: Math.max(0, health.issues.length - 50),\n"
    "  };\n"
    "}\n\n"
    "interface Utf8Page {\n",
)

extension = "modules/phenix-pi/extension/memory-extension.ts"
replace_once(
    extension,
    """    "Notes:",
    ...snapshot.notes.map(
      (note) => `- ${note.id} [${note.kind}/${note.status}] ${note.summary}`,
    ),
  ].join("\\n");
}
""",
    """    "Notes:",
    ...snapshot.notes
      .slice(0, 200)
      .map((note) => `- ${note.id} [${note.kind}/${note.status}] ${note.summary}`),
    ...(snapshot.notes.length > 200
      ? [`[${snapshot.notes.length - 200} additional notes omitted from this inspector]`]
      : []),
  ].join("\\n");
}
""",
)
replace_once(
    extension,
    """  lines.push("", "Issues:");
  for (const issue of health.issues) lines.push(formatMemoryIssue(issue));
  return lines.join("\\n");
}
""",
    """  lines.push("", "Issues:");
  for (const issue of health.issues.slice(0, 200)) lines.push(formatMemoryIssue(issue));
  if (health.issues.length > 200) {
    lines.push(`[${health.issues.length - 200} additional issues omitted]`);
  }
  return lines.join("\\n");
}
""",
)

repository_test = "modules/phenix-pi/tests/memory-repository.test.ts"
replace_once(
    repository_test,
    "): MemoryNote {\n  return {\n",
    '): Extract<MemoryNote, { readonly status: "active" }> {\n  return {\n',
)

index_test = "modules/phenix-pi/tests/memory-search-index.test.ts"
replace_once(
    index_test,
    'function note(id: string, summary: string, status: MemoryNote["status"] = "active"): MemoryNote {\n'
    "  return {\n",
    'function note(id: string, summary: string): Extract<MemoryNote, { readonly status: "active" }> {\n'
    "  return {\n",
)
replace_once(
    index_test,
    "    status,\n",
    '    status: "active",\n',
)
replace_once(
    index_test,
    '  const original = note("memory-status", "Canonical interface", "active");\n',
    '  const original = note("memory-status", "Canonical interface");\n',
)

codec = "modules/phenix-pi/domain/memory/codec.ts"
replace_once(
    codec,
    """function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireBoundedString(value, name, 64);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${name} must be an ISO timestamp`);
  return timestamp;
}
""",
    """function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireBoundedString(value, name, 64);
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(timestamp)) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}
""",
)

codec_test = "modules/phenix-pi/tests/memory-codec.test.ts"
replace_once(
    codec_test,
    "/must be an ISO timestamp/",
    "/must be a canonical UTC ISO timestamp/",
)

docs = Path("docs/MEMORY.md")
text = docs.read_text()
old = """Each action accepts only its declared fields. Required fields, unrelated fields, duplicate
references, and invalid status/metadata combinations are rejected before execution. Evidence reads
use UTF-8 byte offsets and return the next exact byte offset.
"""
new = """Each action accepts only its declared fields. Required fields, unrelated fields, duplicate
references, and invalid status/metadata combinations are rejected before execution. Evidence reads
use UTF-8 byte offsets and return the next exact byte offset. Model-facing snapshots expose at most
20 recent notes and evidence records, and health reports expose at most 50 issues; complete state is
reserved for the user interface and explicit session diagnostics.
"""
if old not in text:
    raise SystemExit("docs bounded interface marker not found")
docs.write_text(text.replace(old, new, 1))
