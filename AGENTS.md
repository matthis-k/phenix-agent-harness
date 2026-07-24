# Phenix agent harness instructions

This file describes the current architecture. Do not infer behavior from historical PRs, deleted APIs, old workflow names, or compatibility aliases.

## Source of truth

Use this order:

1. Executable code and deterministic tests.
2. `docs/INTERFACES.md` for the current runtime design.
3. `modules/phenix-pi/OBSERVABILITY.md` for telemetry behavior.
4. This file for repository working rules.

When documentation and code disagree, investigate the code path and update the documentation in the same change. Do not preserve stale behavior solely because it is documented.

## Execution architecture

- The root Pi session is a read-only frontend and supervisor.
- `phenix_dispatch` is the only substantial root execution entry point.
- Normal substantial requests use `mode=auto`.
- `auto` selects from the capability-filtered catalog using typed candidate descriptions.
- Explicit `qa`, `implement`, and `coordinate` modes are operator overrides, not choices the frontend should make by itself.
- Invariant procedures are typed workflow definitions executed only by `WorkflowProcessManager`.
- Open-ended composition belongs to the read-only `agent.coordinator`; do not create a fake generic workflow.
- `agent.base` is an internal escape hatch and is not root-invokable in production.
- Child agents may use `phenix_run` only within their compiled capability scope.
- Workflow children may be started only by their workflow process manager with valid workflow causation.
- Follow-up input received during active execution is supervisory attention, not a new workflow node or an implicit workflow mutation.
- `AttentionProcessManager` is the only process allowed to route follow-up input into live agent sessions. The internal attention router is not model-facing or ordinarily invokable.

## Runtime invariants

- One append-only JSONL event stream is canonical for each root session.
- A run ID is the only execution identity. Trees, task anchors, active counts, workflow position, effective task state, and attention delivery are projections.
- Children start attached. Background waiting does not detach ownership.
- A parent cannot terminate while an attached child is active.
- Cancellation cascades through attached descendants.
- Detachment is an explicit reparent to the root supervisor.
- Success requires a schema-valid typed outcome and the relevant settled boundary.
- A missing or lost backend becomes a typed failure or orphan; never synthesize success.
- Failed runs remain immutable evidence. Recovery creates a linked replacement run.
- Recovery escalation must be bounded and minimal. Read/search tools or explicit `bash` may be added; `edit` and `write` are never granted directly to a read-only retry.
- Attention targets are active agents in the same root tree. Workflow runs are never directly steered.
- Steering does not settle an await, change ownership, mutate workflow input, or create a replacement run.
- Delivery to a starting child is durable and must be reconstructable from canonical events after restart.

## Agent prompt boundary

- Definition prompts are static system instructions.
- Schema-validated task input is sent separately as task data.
- Never interpolate objectives, repository content, candidate descriptions, or user-provided context into a system prompt.
- Tool availability and child capabilities are enforcement. Prompt text is guidance, not authorization.

## Context and result transport boundary

- Child sessions never inherit the parent conversation.
- Repository context-file inheritance is role-scoped: orchestration and synthesis roles receive none, focused analysis roles receive bounded context, and mutation or independent verification roles retain the full configured allowance.
- The run ledger owns complete typed inputs and outcomes. Do not copy them into secondary registries or prose handoffs.
- Awaited `phenix_run` and `phenix_dispatch` calls return compact status, summary, and handle data by default.
- `phenix_handle` defaults to a summary projection. Request `view=outcome`, `view=failure`, or `view=full` only when the additional payload is required for the current decision.
- Tool-result transport records source, inline, and omitted byte counts. Do not defeat that boundary by embedding complete outcomes into summaries.
- Attention routing receives bounded active-run metadata, not child transcripts, repository context, or complete outcomes.

## Layer ownership

```text
extension -> application -> domain -> ports
adapters ---------------------------> ports
composition -> all layers
definitions -> domain definition types
```

- `domain`: execution concepts, typed definitions, state and invariants.
- `application`: façades, process managers, projections, policy orchestration.
- `ports`: replaceable runtime boundaries, including durable diagnostic logging.
- `adapters`: Pi SDK, process execution, persistence, routing.
- `composition`: the only place concrete adapters are assembled.
- `extension`: Pi-facing commands, tools, widgets, session lifecycle.
- `definitions`: bundled agent and workflow declarations.

The domain and application layers must not import Pi packages or concrete adapters. Avoid generic wrappers with no independent policy or replacement seam.

## Local operations and shell authority

- `local.qa-checks` accepts only structured deterministic check specifications.
- For devenv repositories, automatic QA discovery runs `devenv tasks run maintenance:fix`, `devenv test`, and then the remaining discovered checks in fixed argv form.
- The process adapter compiles each specification to a fixed executable and argument vector.
- Do not reintroduce arbitrary command strings, regex shell allowlists, or implicit shell execution into local workflow operations.
- Arbitrary shell work belongs only to an agent explicitly compiled with `bash`.
- `nix_shell` is a second arbitrary-command tool for those same operational roles. It provides requested packages through an ephemeral `nix shell`; it must never install into a profile or the host system.
- The QA test analyst may run targeted read-only commands to close explicit coverage gaps. Repository, architecture, and synthesis branches remain non-executing unless their own definition explicitly grants command authority.
- Local slash commands are operator actions, but should still avoid accidental implicit shell interpretation.

## Observability and presentation

- `/phenix status` is the only live execution dashboard command.
- The compact status tree omits the synthetic root row and renders one summary row per visible agent or workflow: role, state, and dimmed concrete model/thinking metadata. Running nodes may add one indented bounded activity-description line.
- Completed subtrees collapse by default and summarize completed or exceptional descendants. Active, waiting, and failed branches remain expanded; `--expanded` is the explicit inspection override.
- Status keeps a three-line deduplicated recent-facts tail for quick context. `/phenix facts` owns the complete ordered full-tree history, `/phenix logs` owns structured diagnostics, and `/phenix status --json` exposes complete storage metadata without printing paths in the default dashboard.
- `/phenix logs` is the root-scoped structured diagnostic history with trace, info, warning, and error thresholds.
- Diagnostic scopes are stable lowercase dot-separated semantic identifiers. Dynamic IDs and values belong in fields, not scopes.
- Short scalar telemetry may remain inline. Context, prompts, nested outcomes, provider bodies, tool payloads, and other large values must be content-addressed once and referenced by artifact digest.
- Secret-bearing fields are redacted before diagnostic persistence. Diagnostics are reconstruction aids; they never replace the canonical run ledger.
- Current activity and facts derive from domain events and tool lifecycle data; they do not invoke another model.
- Raw tool output is not persisted in facts.
- Durable command summaries must minimize data and redact secret-bearing values.
- `phenix_progress` is bounded telemetry only. It is not sent to the parent or root model.
- `phenix_present` is reserved for bounded warning, high-severity, or critical findings that must be visible before child completion.
- A presentation is recorded once as a durable reported fact, rendered through the root notifier, and delivered as a bounded next-turn attention message to the root model.
- Presentation fingerprints deduplicate repeated notices; do not use presentation as a progress stream.
- Attention routing and delivery must emit canonical events and stable diagnostic scopes; transport success without a durable delivery event is not authoritative.
- Theme colors are semantic: active, waiting, successful, failed, cancelled, model/thinking level, reported, derived, and muted structural data.
- Plain-text and file exports must remain ANSI-free.

## Change discipline

- Remove obsolete aliases and compatibility paths rather than maintaining unused APIs.
- Prefer the library or platform primitive when it already provides the required behavior.
- Keep interfaces distinct from implementations and keep dependency direction inward.
- Add regression tests for lifecycle races, authorization boundaries, capability changes, persistence, failure propagation, context projection, attention routing/deferred delivery, diagnostic redaction/reference behavior, and presentation deduplication.
- CI is read-only. Formatting fixes run locally through `devenv tasks run maintenance:fix`; CI runs `devenv test`.
- Pin third-party GitHub Actions to full commit SHAs with a version comment.
- Do not add `.stitch.json` unless Stitch actually requires repository-specific metadata that cannot be derived.

## Required verification

Run:

```sh
devenv tasks run maintenance:fix
devenv test
```

A change is incomplete when formatting, typecheck, runtime tests, workflow validation, Nix packaging, or flake evaluation fails.
