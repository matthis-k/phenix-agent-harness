# Phenix memory

Phenix memory reduces prompt residency without discarding execution evidence.
It is an execution-integrated subsystem, not a second task or objective manager.

## Layers

1. **Evidence** — immutable complete tool results, run outcomes, and selected domain events.
   Evidence payloads are content-addressed on disk; compact metadata is stored in JSONL.
2. **Notes** — typed requirements, constraints, decisions, findings, errors, test results,
   changes, preferences, procedures, project facts, outcomes, and observations. Notes retain
   evidence references, reliability, retention policy, objective scope, and validity state.
3. **Working set** — a deterministic projection for one run containing its objective path,
   active or uncertain notes, and relevant evidence references.
4. **Stable memory** — durable notes remain available across recovered Phenix sessions rooted
   in the same run. Cross-project semantic memory is intentionally outside the initial scope.

Objectives remain explicit intention scopes. They improve relevance but are not the canonical
memory representation; a note can exist without an objective and evidence remains authoritative.

## Context assembly

The Pi `context` hook runs before every provider request:

- Below 50% estimated context use, Phenix retains the native transcript and injects a small
  working-memory index when useful.
- At 50%, old tool-result bodies outside the recent tail are replaced by compact descriptions
  with stable evidence IDs.
- At 85%, Phenix additionally prunes old conversational turns toward 65% of the model context
  window while retaining the first user request and a recent verbatim tail.

These transformations affect only provider context. Pi session JSONL and Phenix evidence remain
complete and inspectable.

## Agent interface

`phenix_memory` is registered in root and managed child sessions.

- `search` returns compact typed notes.
- `read` reopens exact immutable evidence by ID with bounded offset/limit paging.
- `note` records durable knowledge that automatic capture cannot infer safely.
- `set_status` marks notes active, uncertain, superseded, or invalidated.
- `snapshot` reports the current memory inventory.

Routine tool results and child outcomes are captured automatically. Agents should not duplicate
those records manually.

## User interface

`/memory` opens a searchable terminal browser. Selecting a note displays its metadata and linked
evidence. `/memory <terms>` prefilters notes and `/memory read <evidence-id>` opens exact evidence
directly.

## Persistence

Memory lives below the configured Phenix state directory:

```text
memory/<root>/
  memory.jsonl
  evidence/<sha256>.txt
```

Metadata is append-only. Re-recording a note ID updates its current projection; evidence payloads
are immutable and deduplicated by content hash.
