# Phenix execution architecture

This document defines the current runtime design. Historical interfaces, deleted bridges, temporary compatibility names, and old agent prompts are not authoritative.

## Authority and entry points

The root Pi session is a read-only frontend and root supervisor. It directly answers only simple read-only questions. Every substantial request enters execution through `phenix_dispatch`.

Normal routing uses `mode=auto`. The dispatch service derives the exact candidate set from the caller's capability-filtered catalog and asks the typed dispatcher to select one definition. The selector must prefer the most specific invariant workflow whose complete contract matches the request. It may choose `agent.coordinator` only when no single workflow covers the task, multiple workflows are required, order depends on intermediate results, or the task is genuinely open-ended.

`qa`, `implement`, and `coordinate` are explicit operator overrides. The frontend must not substitute them for normal catalog-driven selection.

## Definitions and execution mechanisms

An agent definition owns static system instructions, input and output schemas, model selection, tools, context policy, child capabilities, limits, and persistence.

A workflow definition owns an invariant typed graph. Only `WorkflowProcessManager` interprets workflow nodes and starts workflow children. Workflow children cannot be started through the ordinary child-agent path without trusted workflow causation.

Dynamic composition is an agent responsibility. `agent.coordinator` is read-only and composes workflows and focused evidence agents. `agent.base` remains an internal bounded escape hatch and is excluded from the production root allowlist.

## Canonical state

Each root Pi session owns one append-only JSONL domain-event stream. The event stream is canonical. Run trees, task trees, active-child counts, workflow positions, current activity, fact history, outcomes, retry relationships, and structured presentations are projections.

A run ID is the only execution identity for roots, agents, and workflows. Each non-root run has exactly one parent edge.

Application commands use four façades:

- `ExecutionFacade`: run lifecycle and control.
- `TaskFacade`: local task leaves and owned progress.
- `CatalogFacade`: immutable definitions and capability-filtered availability.
- `QueryFacade`: projections and ordered facts.

Event subscribers observe facts; they are not command queues. Only an explicit process manager may react to events by issuing commands. Reducer invariants are checked against a staged projection before a batch is appended.

## Diagnostic reconstruction boundary

`DiagnosticLog` is a replaceable port assembled by composition. The filesystem adapter writes a second root-scoped append-only JSONL stream. This diagnostic stream is not execution authority and cannot drive reducers or recover run state.

The composition layer subscribes to canonical domain events and maps them to stable lowercase dot-separated diagnostic scopes. Runtime, integration, persistence, agent-session, model-resolution, workflow, tool, output, failure, and recovery boundaries may also record explicit diagnostics when the domain event alone lacks enough context.

Diagnostic records keep timestamps, IDs, model names, durations, counts, statuses, and other short scalar fields inline. Large strings and nested values are redacted, serialized once into a private content-addressed artifact store, and replaced by `artifact:sha256:<digest>` metadata. Artifact resolution is root scoped. Diagnostic observers are asynchronous side effects and may never block, mutate, or fail execution.

## Lifecycle and typed outcomes

Runs move through creation, startup, active work, completion, and a terminal state.

Agent success requires:

1. A schema-valid `phenix_return` value.
2. A later settled cycle boundary.
3. No active attached child.

Workflows succeed only through a typed return node after their attached children settle.

A child that cannot complete calls `phenix_fail` with a structured report. Automatic model, provider, backend, timeout, budget, output, workflow, cancellation, and orphan failures use the same typed failure model.

A failed run is immutable evidence. `phenix_handle retry` creates a linked replacement run. Retry overrides are bounded. Recovery may add read/search tools or explicitly escalate to `bash`; it may not add `edit` or `write` directly to a read-only task.

## Structured concurrency

Children begin attached. `wait=background` changes waiting behavior, not ownership.

- Parent cancellation cascades through attached descendants.
- A parent cannot become terminal while an attached child is active.
- Detachment is an explicit reparent to the root supervisor.
- The parent and root can inspect, await, message, retry, or cancel accessible descendants.
- A lost in-memory backend becomes `orphaned`, never successful.
- File-backed child sessions may be recovered from their Pi session reference.

## Prompt, context, and capability boundary

System prompts contain only static definition instructions plus the static execution protocol. Schema-validated objectives, context, candidate descriptions, plans, findings, and other task values are sent separately as task data.

Child sessions never inherit the parent conversation. Repository context files are admitted according to the owning agent definition:

- dispatcher, coordinator, finalizer, and QA synthesizer: no automatic repository context;
- tester: 32 KB maximum;
- scout, planner, architect, and critic: 64 KB maximum;
- implementer, verifier, and internal base: 128 KB maximum.

Prompt text does not authorize behavior. Authorization is enforced by:

- the root definition allowlist,
- compiled tools,
- invokable definition capabilities,
- maximum delegation depth,
- detachment and messaging permissions,
- workflow node causation,
- task and descendant scope checks.

Authorization occurs before durable creation and is repeated after asynchronous model resolution to close stale-parent races.

## Result transport

The run ledger retains complete schema-valid inputs and outcomes. Model-facing tools do not automatically inline those complete values.

- Awaited `phenix_run` and `phenix_dispatch` calls return a compact run ID, state, summary, and failure metadata when applicable.
- `phenix_handle inspect` and `await` default to `view=summary`.
- `view=outcome` admits the complete typed outcome.
- `view=failure` admits the complete failure projection when one exists.
- `view=full` admits the full run snapshot and is intended only for explicit diagnostics.
- Tool-result details include deterministic source, inline, and omitted byte counts without duplicating the omitted source payload.

Workflow process managers are not model-facing transports and continue to consume child outcomes directly through the execution authority.

## Structured presentation

`phenix_present` publishes a bounded warning, high-severity, or critical finding before child completion. It is available only to operational agents.

A presentation:

1. is schema validated and size bounded;
2. receives a deterministic fingerprint scoped to its source run;
3. is stored once as a reported `finding-reported` fact;
4. is rendered immediately through the root notifier;
5. is delivered to the root model as a bounded next-turn attention message.

Repeated presentations with the same fingerprint are acknowledged but not emitted again. Ordinary status remains the responsibility of `phenix_progress`, which does not message the root model.

## Process authority

`local.qa-checks` is deliberately narrower than `bash`. It accepts structured deterministic check specifications and compiles them to fixed executable/argument pairs. Automatic discovery for a devenv repository runs `devenv tasks run maintenance:fix`, `devenv test`, and then the remaining detected checks in a deterministic order. Arbitrary command strings and implicit shell composition are not part of the local-operation contract.

The QA test analyst receives `bash` and `nix_shell` so it can close explicit test-coverage gaps after interpreting the local check results. Repository scouting, architecture review, and synthesis remain non-executing unless their own definitions explicitly grant command authority.

`nix_shell` is an operational child-session tool with the same command-execution authority as `bash`. It normalizes bare package names through `nixpkgs`, evaluates explicit flake installables without shell interpolation, runs the requested command inside an ephemeral environment, and never installs packages into a profile or the host system.

The operator-facing clipboard commands also spawn an executable directly. Shell behavior remains available only when the operator explicitly chooses a shell executable such as `sh -c`.

## Pi boundary

The root extension is a host adapter. Each child agent owns one public Pi `AgentSession` and one `SessionManager`.

Pi session entries store only root binding and ledger cursor information. Cross-session execution state remains in `.phenix-agent-state/runs/*/events.jsonl`. Root-scoped diagnostics live beside the ledger as `logs.jsonl`, with referenced payloads under `artifacts/sha256`.

Every child records its requested model selector and the concrete model selected by the versioned routing policy. The `phenix` provider is virtual: it performs no authentication itself and forwards the concrete provider credentials obtained from Pi's model registry.

## Public Pi tools

- `phenix_dispatch`: the root's sole substantial execution entry point; returns a compact result envelope.
- `phenix_run`: invokes an authorized catalog definition from a child agent; returns a compact result envelope.
- `phenix_handle`: inspects, awaits, messages, cancels, or retries an accessible descendant, with explicit result views.
- `phenix_tasks`: reads the derived tree and mutates only local task leaves or owned progress.
- `phenix_return`: submits a child agent's typed success value.
- `phenix_fail`: submits a structured child failure.
- `phenix_progress`: updates bounded run telemetry without messaging the parent or root model.
- `phenix_present`: records and propagates a bounded material finding to the user and root model.
- `nix_shell`: runs a command with ephemeral Nix-provided packages for command-authorized child agents.

## Package boundaries

```text
extension -> application -> domain -> ports
adapters ---------------------------> ports
composition -> all layers
definitions -> domain definition types
```

The domain and application layers contain no Pi imports and no concrete adapter imports. Concrete adapters meet only in `composition/create-phenix-runtime.ts`. TypeBox is currently the explicit schema-contract implementation; do not pretend it is abstracted by moving isolated imports without replacing the complete schema construction and validation boundary.
