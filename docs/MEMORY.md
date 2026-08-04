# Phenix memory

Phenix memory reduces provider-context residency without discarding execution evidence. It is a
runtime capability with a closed policy, protocol, state machine, and persistence format. Models
choose what durable knowledge to record; they cannot redefine the interface or persistence rules.

## Domain model

1. **Evidence** is immutable source material: complete tool results, child outcomes, and selected
   domain events. Payloads are content-addressed by SHA-256 and stored separately from metadata.
2. **Notes** are compact typed statements: requirements, constraints, decisions, findings, errors,
   test results, changes, preferences, procedures, project facts, outcomes, and observations.
3. **Validity** is explicit. Notes are active, uncertain, superseded, or invalidated. Invalidation
   metadata is valid only for an invalidated note, and supersession changes are committed atomically.
4. **Working memory** is a deterministic projection for one run. Objective scope influences
   relevance but does not own or replace memory.

Evidence is authoritative. Notes and injected context are indexes into evidence, not substitutes for
it.

## Static contracts

The concrete Phenix runtime must provide one validated `MemoryPolicy`. It controls:

- context-window fallback, fold thresholds, protected message tails, working-set sizes, and canvas
  limits;
- maximum evidence, read, and search sizes;
- synchronized writes and read-time evidence verification;
- automatic maintenance thresholds and retention periods;
- whether memory failures isolate memory and continue the session or fail strictly.

Invalid threshold ordering, non-positive limits, and invalid retention periods fail during runtime
composition. The validated policy and its nested values are frozen.

The model-facing `phenix_memory` parameters form a closed TypeBox discriminated union. Supported
actions are:

- `snapshot`
- `health`
- `search`
- `read`
- `note`
- `set_status`

Each action accepts only its declared fields. Required fields, unrelated fields, duplicate
references, and invalid status/metadata combinations are rejected before execution. Evidence reads
use UTF-8 byte offsets and return the next exact byte offset.

## Automatic capture and context assembly

Tool results and child outcomes are captured automatically. Agents should not duplicate routine
execution output as manual notes.

Before every provider request, Phenix:

1. estimates current context use;
2. retrieves the objective-aware working set using the configured limit;
3. injects a bounded reversible memory index;
4. once the configured threshold is crossed, replaces old tool-result bodies outside the protected
   tail with compact evidence references;
5. applies the more aggressive configured tail only after the second threshold.

User and assistant conversation turns are never removed by this layer. The transformation affects
provider context only; Pi transcripts and Phenix evidence remain complete.

If memory is corrupt or unavailable under the default policy, context assembly returns native
history without memory rather than failing the model request. Strict policy is available for hosts
that require memory initialization to be a session invariant.

## Persistence guarantees

Memory is stored below the configured Phenix state directory:

```text
memory/<root-hash>-<safe-root-prefix>/
  memory.jsonl
  evidence/<sha256>.txt
```

The canonical JSONL entries are:

- `evidence.recorded` for one immutable evidence record;
- `notes.recorded` for one non-empty atomic batch of note creations or validity transitions.

Persisted JSON is parsed as `unknown` and decoded through one audited codec. Unknown entry types,
unknown fields, malformed IDs, invalid hashes, timestamps, enums, root mismatches, evidence
redefinitions, illegal note mutations, and malformed batches are rejected.

Evidence persistence is ordered:

1. validate maximum size, declared byte count, and SHA-256;
2. write a mode-0600 private temporary file;
3. synchronize it when configured;
4. hard-link it atomically into the content-addressed store;
5. synchronize the directory when configured;
6. append and optionally synchronize metadata only after the payload is durable.

A repeated content hash reuses the payload after integrity verification while retaining distinct
evidence identities and provenance.

## Integrity and lifecycle states

Each root is represented as one of two service states:

- **available**: healthy or recoverably degraded and writable;
- **unavailable**: corrupt or inaccessible and read-only.

Semantic validation additionally rejects dangling evidence references, missing note references,
self-references, and supersession cycles before notes enter a working set.

Health states are:

- `healthy`: no detected issue;
- `degraded`: only a recoverable incomplete final JSONL line;
- `corrupt`: complete ledger corruption, invalid reference graph, missing payload, or payload
  size/hash mismatch;
- `unavailable`: storage could not be accessed.

The default failure mode records typed diagnostics, isolates only that memory root, and leaves the
agent runtime usable. Writes and direct memory reads fail explicitly while snapshots, health, and
native provider context remain available.

## Repair and maintenance

Repair is deliberately narrow. `/memory repair` may remove only an incomplete trailing JSONL
entry, the expected result of a process stopping during append. Complete middle-ledger corruption,
reference corruption, and evidence corruption are never silently rewritten.

Maintenance:

- requires a clean ledger;
- applies retention by note class;
- rewrites one compact current-state ledger atomically;
- preserves unreferenced evidence, because it may still be addressed externally;
- removes payloads only when they were referenced exclusively by expired notes;
- preserves payloads shared by retained evidence records;
- reports removed notes, evidence records, reclaimed bytes, and ledger-size changes.

Automatic maintenance runs at root initialization only when enabled, the ledger is clean, and the
configured byte threshold has been crossed.

## User interface and operations

The Memory workspace pane begins with a health row showing state, writability, note/evidence counts,
stored bytes, and issue classes. Notes follow in validity order.

Operational commands:

```text
/memory [search terms]
/memory read <evidence-id>
/memory health
/memory verify
/memory snapshot
/memory policy
/memory repair
/memory maintain
/memory set-status <note-id> <active|uncertain|superseded>
/memory set-status <note-id> invalidated [invalidating-note-id]
```

`health` checks metadata and capacity without reading every payload. `verify` validates every
payload against its byte count and SHA-256. `policy` displays the effective frozen configuration.

## RTK token reduction

RTK is a replaceable token-reduction backend, not a second evidence authority. When RTK reduction
is losslessly recoverable, complete raw output is imported into Phenix evidence before the compact
result reaches the model. Stable `phenix_memory read` references replace temporary recovery paths.
Memory integrity and failure-isolation rules apply equally to RTK-imported evidence.

## Capacity, privacy, and scope

Evidence may contain complete command output, source excerpts, paths, and tool inputs. The state
directory is therefore private local state; directories are mode 0700 and files are mode 0600.
Operators must treat exported session manifests and memory evidence as potentially sensitive.

The initial production scope remains root/session-local deterministic retrieval. Embeddings,
cross-project semantic memory, persona synthesis, and background memory agents are intentionally
separate future capabilities rather than hidden behavior in this interface.

## Format policy

Phenix is pre-release and maintains one canonical in-repository API. The production ledger uses
`notes.recorded`; the earlier draft `note.recorded` shape is not retained as a compatibility path.
Old draft state should be removed or explicitly converted outside the runtime before use.
