# Phenix ACP gateway runtime

The Phenix ACP boundary is implemented in Rust. It is not a TypeScript ACP server and it does not treat a complete Phenix run tree as one ACP session.

## Ownership model

A `PhenixAcpGateway` owns any number of independently configured session trees. Each tree is created from one validated, immutable `SessionTreeDefinition`. A tree contains Phenix session nodes and objectives; every live session node owns exactly one downstream standard ACP session.

```text
Phenix session tree
  root node       -> ACP session A
  implementer     -> ACP session B
  verifier        -> ACP session C
  discovered task -> ACP session D
```

The gateway is authoritative for:

- tree and node identity;
- parent/child relationships;
- objectives and objective state;
- workflow expansion;
- routing decisions;
- backend and model selection;
- node-to-ACP-session bindings;
- subtree cancellation and orderly shutdown.

The downstream agent remains authoritative for the contents and execution of its singular ACP session.

## Builder boundary

Configuration and executable policy are registered before the gateway is built:

```rust
let gateway = PhenixAcpGateway::builder()
    .definition(definition)?
    .router(router_id, router)?
    .workflow(workflow_id, workflow)?
    .backend(backend_id, session_factory)?
    .build()?;
```

`build()` rejects missing or duplicate definitions, routers, workflows, and backend factories. A router cannot select a backend outside the immutable tree definition. Workflow plans are validated as topologically ordered trees before any nodes are committed.

`WorkflowPlanBuilder` provides the declarative builder for recursive execution plans. Executable routers and workflows are Rust traits, so policy is strongly typed and testable rather than represented as unchecked command strings.

## Session lifecycle

The backend factory receives an explicit `SessionOpenKind`:

- `New`, optionally related to a parent ACP session;
- `Load` for a persisted ACP session;
- `Resume` for a resumable ACP session;
- `Fork` for a real ACP fork.

The live official-SDK adapter shares one ACP process connection per Phenix tree and returns one session handle per node. It reuses the session created during initialization for the tree root, creates delegated sessions on the same connection, keeps streamed events isolated by projected run ID, and shuts the connection down when its final session handle closes.

Session commands cover prompts, images, steering, queued follow-ups, compaction, cancellation, rename, model/mode/thinking selection, advertised commands, polling, and close. Tool calls, transcript deltas, terminal state, queues, permission requests, completion, failure, and cancellation are projected back as typed session events.

## Host interfaces

`GatewayCommand`, `GatewayReply`, and `GatewayEnvelope` form a serializable host boundary. TypeScript and Lua hosts can call this boundary or generated bindings without owning ACP transport or reimplementing routing and workflow semantics.

The Ratatui frontend remains a projection and interaction layer. It consumes typed runtime state and never decides backend-specific routing policy.

## Migration and fallback

The existing Pi JSONL process adapter remains an explicit fallback until the packaged ACP path passes real-agent end-to-end tests for authentication, persistence, permissions, tools, terminals, images, steering, follow-ups, compaction, and recovery. New orchestration behavior belongs in the Rust gateway; it must not be added to the JSONL adapter.

MCP forwarding remains deferred.
