# Workflow replay checkpoints

Phenix persists automatic workflow replay checkpoints for live workflow runs. A checkpoint is a derived optimization over the canonical event ledger; it is not a second source of truth and is not a model-authored workflow node.

## Canonical authority

The root-scoped append-only domain-event stream remains authoritative. Node entries, node completions, transitions, child causation, child outcomes, and terminal results continue to be persisted as ordinary events.

A crash may occur before a checkpoint is written. Recovery must therefore remain correct with:

- the latest compatible checkpoint plus later canonical events;
- an older compatible checkpoint plus a longer event tail; or
- complete event replay when no checkpoint can be trusted.

## Checkpoint contract

`workflow.checkpoint.saved` contains:

- checkpoint contract version;
- workflow definition ID;
- a deterministic fingerprint of the workflow graph, schemas, and limits;
- the canonical event sequence included by the snapshot;
- a deterministic snapshot fingerprint;
- activations and their completion state;
- accumulated node results;
- transition traversal counts.

Child outcomes are not duplicated into the checkpoint. They remain derived from child run records and their workflow causation metadata.

## Validation and fallback

Graph-state reconstruction scans newest checkpoints first. A checkpoint is ignored when:

- its version or shape is unsupported;
- its definition ID differs;
- the current workflow contract fingerprint differs;
- its included sequence is outside the valid event range;
- its snapshot fingerprint does not match;
- activations reference unknown nodes;
- result entries reference unknown nodes;
- transition counters reference undeclared edges;
- IDs or counters are duplicated or malformed.

Ignoring a checkpoint is not a workflow failure. Reconstruction falls back to an older compatible checkpoint or complete canonical replay.

## Persistence process

`WorkflowCheckpointProcessManager` observes committed workflow state events. It serializes checkpoint writes per workflow run and coalesces multiple events from one transition batch. Checkpoint persistence failures are reported through the ordered domain-event subscriber error boundary; they do not mutate workflow execution state.

Only live workflow runs accept new checkpoints. Terminal outcomes remain immutable evidence.

## Dynamic workflows

Dynamic workflow snapshots and workflow replay checkpoints are separate contracts:

- the dynamic workflow snapshot persists the generated definition and its definition/schema identity;
- the replay checkpoint persists the current execution position for that already-restored definition.

Dynamic definition restoration therefore occurs before nonterminal workflow recovery. A definition-drift failure prevents execution before a replay checkpoint is considered.

## DSL boundary

The workflow DSL still has no explicit checkpoint node. Checkpoint placement is an engine concern and cannot grant tools, capabilities, local operations, or control-flow authority to a model-generated graph.
