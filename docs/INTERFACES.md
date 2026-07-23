# Phenix execution interfaces

The canonical Phenix state is one append-only event stream per root Pi session.

## Runtime identity

A run ID is the only identity for a root session, agent session, or workflow session. Each non-root run stores exactly one parent edge. Root, depth, active-child counts, task anchors, workflow position, and effective task state are projections.

## Commands and facts

Application commands call one of four façades:

- `ExecutionFacade` starts definitions and controls run lifecycles.
- `TaskFacade` mutates only local task leaves.
- `CatalogFacade` reads immutable definitions.
- `QueryFacade` reads projections and the ordered event stream.

Committed domain events are facts. Event subscribers never serve as command queues; only the workflow process manager may react to facts by issuing direct child commands. Reducer invariants are evaluated against a staged projection before a batch is appended, so a rejected transition never corrupts the durable stream.

## Lifecycle and outcomes

Runs move through `created`, startup, active, completion, and terminal states. Terminal outcomes are typed as success, failure, or cancellation; an orphan is a failed outcome with an `orphaned` code. Agent success requires both an accepted schema-valid `phenix_return` value and a later `agent_settled` boundary. Workflow success requires a typed return node and settled attached children.

## Structured concurrency

Children begin attached. Background mode changes waiting, not ownership. Parent cancellation cascades through attached descendants, and a parent cannot become terminal while an attached child remains active. Detachment is an explicit reparent to the root supervisor. A lost backend produces `orphaned`, never success.

## Pi boundary

The root extension is a host adapter. Child agents use one public Pi `AgentSession` and one `SessionManager` each. `agent_settled` records a cycle-idle boundary; semantic completion additionally requires a schema-valid `phenix_return` value and no active attached child.

Pi session entries persist only the root binding and ledger cursor. The cross-session run and task trees remain in `.phenix-agent-state/runs/*/events.jsonl`. On recovery, file-backed child sessions are reopened; unrecoverable in-memory children become orphaned. Every child records both its requested model selector and the concrete model chosen by the versioned routing policy.

## Pi tools

- `phenix_run` invokes a catalog definition and either awaits its typed outcome or returns its run ID for background work.
- `phenix_handle` inspects, awaits, messages, or cancels an accessible descendant without introducing another handle identity.
- `phenix_tasks` reads the derived execution tree and manages only local task leaves and owned progress.
- `phenix_return` exists only inside child agent sessions and submits the definition's output schema.

The `/phenix` command provides read-only status, run, task, and catalog views.

## Package boundaries

```text
extension -> application -> domain -> ports
adapters ---------------------------> ports
composition -> all layers
definitions -> domain definition types
```

The domain and application layers contain no Pi imports. Concrete adapters meet only in `composition/create-phenix-runtime.ts`.
