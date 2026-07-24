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

Each root Pi session owns one append-only JSONL domain-event stream. The event stream is canonical. Run trees, task trees, active-child counts, workflow positions, current activity, fact history, outcomes, and retry relationships are projections.

A run ID is the only execution identity for roots, agents, and workflows. Each non-root run has exactly one parent edge.

Application commands use four façades:

- `ExecutionFacade`: run lifecycle and control.
- `TaskFacade`: local task leaves and owned progress.
- `CatalogFacade`: immutable definitions and capability-filtered availability.
- `QueryFacade`: projections and ordered facts.

Event subscribers observe facts; they are not command queues. Only an explicit process manager may react to events by issuing commands. Reducer invariants are checked against a staged projection before a batch is appended.

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

## Prompt and capability boundary

System prompts contain only static definition instructions plus the static execution protocol. Schema-validated objectives, context, candidate descriptions, plans, findings, and other task values are sent separately as task data.

Prompt text does not authorize behavior. Authorization is enforced by:

- the root definition allowlist,
- compiled tools,
- invokable definition capabilities,
- maximum delegation depth,
- detachment and messaging permissions,
- workflow node causation,
- task and descendant scope checks.

Authorization occurs before durable creation and is repeated after asynchronous model resolution to close stale-parent races.

## Process authority

`local.qa-checks` is deliberately narrower than `bash`. It accepts structured deterministic check specifications and compiles them to fixed executable/argument pairs. Arbitrary command strings and implicit shell composition are not part of the local-operation contract.

The operator-facing fact clipboard command also spawns an executable directly. Shell behavior remains available only when the operator explicitly chooses a shell executable such as `sh -c`.

## Pi boundary

The root extension is a host adapter. Each child agent owns one public Pi `AgentSession` and one `SessionManager`.

Pi session entries store only root binding and ledger cursor information. Cross-session execution state remains in `.phenix-agent-state/runs/*/events.jsonl`.

Every child records its requested model selector and the concrete model selected by the versioned routing policy. The `phenix` provider is virtual: it performs no authentication itself and forwards the concrete provider credentials obtained from Pi's model registry.

## Public Pi tools

- `phenix_dispatch`: the root's sole substantial execution entry point.
- `phenix_run`: invokes an authorized catalog definition from a child agent.
- `phenix_handle`: inspects, awaits, messages, cancels, or retries an accessible descendant.
- `phenix_tasks`: reads the derived tree and mutates only local task leaves or owned progress.
- `phenix_return`: submits a child agent's typed success value.
- `phenix_fail`: submits a structured child failure.
- `phenix_progress`: updates bounded run telemetry without messaging the parent model.

## Package boundaries

```text
extension -> application -> domain -> ports
adapters ---------------------------> ports
composition -> all layers
definitions -> domain definition types
```

The domain and application layers contain no Pi imports and no concrete adapter imports. Concrete adapters meet only in `composition/create-phenix-runtime.ts`. TypeBox is currently the explicit schema-contract implementation; do not pretend it is abstracted by moving isolated imports without replacing the complete schema construction and validation boundary.
