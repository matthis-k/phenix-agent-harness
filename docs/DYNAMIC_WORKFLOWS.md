# Dynamic workflow composition

Phenix may dynamically author orchestration without treating model-generated source code as execution authority.

## Boundary

The root supervisor first prefers one complete predefined workflow. When no single definition covers the request, the Markdown-defined `agent.coordinator` may propose a graph assembled from its capability-filtered building-block catalog.

The composer receives `request.dynamic-workflow-composition.v1` and returns `request.dynamic-workflow-proposal.v1`. It has no tools, repository context, or direct child execution authority. It does not execute JavaScript, register functions, grant tools, or construct runtime objects directly.

A trusted compiler:

1. validates the proposal schema;
2. rejects definitions outside the supplied capability-filtered catalog;
3. resolves referenced definition and schema contracts;
4. validates all data bindings;
5. rejects result references that are not upstream of their consumer;
6. compiles bindings into pure runtime mappings;
7. validates the resulting ordinary `WorkflowDefinition`;
8. seals a deterministic graph identity and contract digests.

Only the sealed result may enter workflow execution.

## Dispatch policy

Normal `phenix_dispatch` selection still prefers the most specific complete predefined workflow. `workflow.qa` and `workflow.implement` therefore execute directly when selected.

When the selector chooses `agent.coordinator`, dispatch performs three distinct runs:

1. the optional dispatcher selects the composition fallback;
2. the no-tools composer returns a declarative graph proposal;
3. `DynamicWorkflowExecutionService` recompiles, rechecks the composer's concrete definition scope, persists the sealed graph, and starts the dynamic workflow under the original dispatch parent.

The completed composer remains immutable evidence but is not the dynamic workflow's structural parent. Its run ID is retained as `composerRunId`, and its compiled child capability set is the authority used to validate the proposal.

Explicit `mode=coordinate` skips only the selector. It still uses the same composer and trusted execution path.

## Initial graph subset

The compiler supports:

- awaited `invoke` nodes;
- `join` nodes;
- `return` nodes;
- bounded invoke retry metadata;
- unconditional outcome transitions;
- acyclic graphs;
- root-input, prior-node, literal, object, and array bindings.

It deliberately excludes:

- JavaScript or arbitrary expressions;
- dynamically invented mapping or condition functions;
- local operations;
- decision nodes and conditional predicates;
- background invocations;
- cycles;
- capability overrides;
- runtime collection fan-out;
- checkpoint nodes.

These restrictions keep the execution surface statically inspectable and prevent composition from becoming a capability bypass.

## Identity and drift

Every compiled proposal receives an identity containing:

- a canonical graph digest;
- a digest for each referenced definition contract;
- a digest for the workflow input and output schemas.

Definition contract digests include prompts, model policy, tools, context policy, child capabilities, limits, persistence, and nested workflow graphs. Recovery or replay can therefore distinguish unchanged, changed, and incompatible execution contracts instead of silently recompiling against current definitions.

The generated definition ID is derived from the graph digest:

```text
workflow.dynamic.<24 hex characters>
```

The complete sealed proposal and identity are persisted in the dynamic workflow run's compiled specification. Root startup restores the hidden definition and mappings before normal nonterminal recovery. A live run fails deterministically if restoration detects definition or schema drift.

## Runtime registration

`DynamicWorkflowRuntimeRegistry` installs compiled graphs into runtime-only overlays after the static definition catalog and function registry have been sealed.

The overlays have deliberately narrow behavior:

- only content-addressed `workflow.dynamic.*` definitions and mappings are accepted;
- dynamic definitions remain absent from `DefinitionCatalog.list()`, so they cannot become dispatcher candidates or model-facing catalog entries;
- static definitions and functions remain immutable;
- repeated installation of the same graph is idempotent;
- an ID associated with a different full graph identity is rejected;
- restoration recompiles the persisted proposal and rejects definition or schema drift before registration.

The overlay is an execution cache, not persistence authority. The persisted snapshot remains the proposal plus its full graph, definition, and schema identity.

## Deferred extensions

Persistent checkpoints, capability-scoped generic mutation fallbacks, runtime collection fan-out, and cross-run activation replay remain separate extensions. They must preserve the same compiler, identity, and capability boundaries.
