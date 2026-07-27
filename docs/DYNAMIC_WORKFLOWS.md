# Dynamic workflows

Phenix uses dynamic workflows only when no single predefined workflow covers the request.

## Selection

Normal `phenix_dispatch` selection prefers the most specific complete predefined workflow. When the selector chooses `agent.coordinator`, the coordinator receives the available definition and schema catalog and returns a declarative graph proposal.

The coordinator has no tools, repository context, or direct child execution. The proposal is validated before a run is created. Explicit `mode=coordinate` skips selection but uses the same proposal and validation path.

Dynamic dispatch retains the completed coordinator run as `composerRunId`. The resulting workflow remains a child of the original dispatch parent.

## Supported graph

A proposal may contain:

- awaited `invoke` nodes;
- `join` nodes;
- `return` nodes;
- bounded invoke retries;
- unconditional outcome transitions;
- acyclic dependencies;
- input, prior-result, literal, object, and array bindings.

It may not contain:

- JavaScript or arbitrary expressions;
- invented mapping or condition functions;
- local operations;
- decision nodes;
- background invocations;
- cycles;
- capability overrides;
- runtime collection fan-out;
- checkpoint nodes.

Every referenced definition must be present in the coordinator's catalog, every binding must be schema compatible, and a node may consume results only from upstream nodes.

## Identity and recovery

The generated ID uses the graph digest:

```text
workflow.dynamic.<24 hex characters>
```

The persisted run stores the proposal, graph digest, referenced definition digests, and schema digests. Startup restores the generated definition before recovering live runs. A changed or incompatible referenced definition fails the live workflow instead of silently recompiling it.

Generated definitions are hidden from ordinary catalog listing and dispatch selection. Reinstalling the same generated graph is idempotent; reusing its ID for different content is rejected.
