# Deterministic workflow kernel

Phenix workflows separate **orchestration policy** from **variable work**.

The workflow kernel owns ordering, handoffs, retries, joins, limits, recovery, and terminal
behavior. Agents and local operations supply only the result of a bounded step. They cannot
silently rewrite the procedure that consumes that result.

## Authority boundary

A workflow run has three authorities:

1. The compiled `WorkflowDefinition` declares the graph, schemas, limits, retry policy, and
   permitted child definitions.
2. The append-only run ledger records node activations, child runs, typed outcomes, and taken
   transitions.
3. The pure workflow planner derives exactly one next command from those two inputs.

The process manager executes the command and records the resulting events. It does not contain a
second, imperative orchestration policy.

```text
compiled workflow + durable projection
                |
                v
       pure workflow planner
                |
        one typed command
                |
                v
       effect executor / ledger
```

Replaying the same definition and durable projection therefore produces the same next command.
External work may vary, but its scheduling and consumption do not.

## Deterministic scheduling

Active node activations are considered by:

1. durable entry sequence;
2. activation ID as a stable tie-breaker.

A blocked activation does not prevent a later independent activation from progressing. Blocking
reasons are explicit data: a running child, exhausted parallelism, an incomplete join, or attached
children at a return barrier.

The planner, rather than an agent prompt, owns:

- child invocation and typed causation;
- bounded retry selection and replacement linkage;
- success, failure, cancellation, and conditional edge selection;
- join readiness and quorum calculation;
- propagation of unhandled child failures;
- return barriers for attached children;
- node-run and parallelism limits.

## Agent handoffs

An invocation is a typed boundary:

- a registered pure mapping constructs the child input;
- the child definition fixes its input schema, output schema, tools, context, limits, and child
  capabilities;
- the child run records workflow run, node, and activation causation;
- the workflow consumes only the schema-valid terminal outcome;
- a retry creates a linked replacement run and never mutates the failed evidence.

Agents decide how to perform their assigned work. They do not choose their successor, bypass a
join, expand their permissions, reinterpret retry policy, or mark the workflow complete.

## Dynamic workflows

Dynamic composition remains possible, but agents propose constrained workflow data rather than
runtime code. The dynamic compiler validates definition scope, schemas, bindings, graph shape, and
limits, then content-addresses the result. The installed definition is executed by the same kernel
as a bundled workflow.

This keeps flexibility at the definition boundary without giving the composing agent control of
the execution machinery.

## Tool and local-operation boundary

Workflow-owned local operations are registered capabilities, not arbitrary command strings. Their
input is produced by a registered mapping and the process adapter compiles structured requests to
fixed executable/argument pairs.

Every local operation receives a stable `executionId` derived from the workflow run, activation,
and node. The ID is unchanged when the process manager reconstructs the same activation after
recovery. New effectful operation adapters must use it as an idempotency key or reject replay;
read-only operations may execute it repeatedly.

Model-facing tools follow the same principle:

- parameters are schema-validated before execution;
- availability comes from the compiled tool allowlist and run capability scope;
- the tool implementation, not prompt prose, owns authorization and invariants;
- durable execution should return handles to canonical runs rather than creating parallel prose
  state;
- mutations require an explicit operation with bounded inputs and a defined recovery policy.

The model chooses **which permitted operation and arguments** to request. Fixed code decides
whether the request is valid, what it may affect, how it is represented durably, and how failure or
recovery behaves.

## Extension rules

When adding workflow or tool behavior:

1. Prefer a new typed node, command, mapping, or registered operation over prompt instructions.
2. Put branching, ordering, retries, and completion criteria in workflow data or kernel code.
3. Keep planner inputs immutable and planner output serializable and exhaustively typed.
4. Record an intent before performing a non-replay-safe effect, or make the adapter deduplicate by
   stable execution identity.
5. Parse untrusted model output into a schema-valid value before it reaches orchestration state.
6. Keep arbitrary shell authority inside explicitly authorized agents; never smuggle it into a
   generic local operation.
7. Add planner tests for every new state transition and integration tests for executor/ledger
   behavior.
