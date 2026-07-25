# Dynamic workflow composition

Phenix may dynamically author orchestration without treating model-generated source code as execution authority.

## Boundary

The root supervisor first prefers one complete predefined workflow. When no single definition covers the request, a Markdown-defined composer may propose a graph assembled from the caller's capability-filtered catalog.

The model produces `request.dynamic-workflow-proposal.v1`, a declarative object. It does not execute JavaScript, register functions, grant tools, or construct runtime objects directly.

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

## Initial graph subset

The first compiler slice deliberately supports:

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

These restrictions keep the first execution surface statically inspectable and prevent a composition request from becoming a capability bypass.

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

The complete sealed proposal and identity must be persisted with the run before runtime execution is enabled.

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

## Next execution slice

Execution integration must persist the dynamic snapshot in the owning workflow run, restore runtime overlays before nonterminal recovery, and provide a trusted start path that rechecks the caller's current composition scope. `WorkflowProcessManager` can then execute the installed graph through the same lifecycle and structured-concurrency rules as bundled workflows.

The composer agent and dispatch integration follow that trusted start path. Persistent checkpoints and capability-scoped generic fallback agents should be added only after it exists.
