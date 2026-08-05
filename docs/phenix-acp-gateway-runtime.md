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

`build()` rejects missing or duplicate definitions, routers, workflows, and backend factories. A router cannot select a backend outside the immutable tree definition. Workflow plans are validated as topologically ordered trees before any nodes are committed. Creating a tree with an explicit ID also rejects an existing ID through the typed `tree.duplicate` gateway error rather than overwriting live state.

`WorkflowPlanBuilder` provides the declarative builder for recursive execution plans. Executable routers and workflows are Rust traits, so policy is strongly typed and testable rather than represented as unchecked command strings.

## Session lifecycle

The backend factory receives an explicit `SessionOpenKind`:

- `New`, optionally related to a parent ACP session;
- `Load` for a persisted ACP session;
- `Resume` for a resumable ACP session;
- `Fork` for a real ACP fork.

The live official-SDK adapter shares one ACP process connection per Phenix tree and returns one session handle per node. It reuses the session created during initialization for the tree root, creates delegated sessions on the same connection, keeps streamed events isolated by projected run ID, and shuts the connection down when its final session handle closes.

Session commands cover prompts, images, steering, queued follow-ups, compaction, cancellation, rename, model/mode/thinking selection, advertised commands, polling, and close. Tool calls, transcript deltas, terminal state, queues, permission requests, completion, failure, and cancellation are projected back as typed session events.

## Frontend integration

The Ratatui ACP backend owns a `PhenixAcpGateway` and a shared tree transport rather than constructing the former singular-session adapter directly. The control plane and all node sessions use one ACP process connection per tree, so authentication, permissions, terminals, models, persisted-session operations, and recursive orchestration remain coherent.

Frontend session actions are translated into gateway operations:

- creating, loading, resuming, and forking sessions creates typed Phenix nodes;
- prompts, images, steering, follow-ups, compaction, model changes, mode changes, thinking changes, and advertised commands target the selected node;
- cancellation propagates through the selected subtree;
- gateway parentage, objectives, session state, and downstream ACP bindings are projected into the frontend runtime snapshot.

Projection uses typed runtime IDs and fails explicitly when a downstream session cannot be resolved to its corresponding run or tree node; it does not silently invent detached frontend state.

Authentication can complete before the root tree node exists. Once the downstream backend exposes a usable ACP session, the adapter creates the root tree with an explicit stable tree ID and binds the initialized session to that root.

## Host interfaces

`GatewayCommand`, `GatewayReply`, and `GatewayEnvelope` form a serializable host boundary. TypeScript and Lua hosts can call this boundary or generated bindings without owning ACP transport or reimplementing routing and workflow semantics.

The Ratatui frontend remains a projection and interaction layer. It consumes typed runtime state and never decides backend-specific routing policy.

## Packaged verification

The `phenix-acp-smoke` binary is built from the same Rust workspace and uses the official ACP SDK for both endpoints. It starts a credential-free fixture agent over stdio, constructs the standard Phenix gateway preset, creates a tree, verifies that its root node owns a downstream ACP session, executes and completes a prompt, closes the tree, and verifies that the tree registry is empty.

The Nix frontend smoke check installs and executes this binary. This makes the packaged gateway path part of repository verification without requiring network access, credentials, or a production model provider.

## Default backend and fallback

The packaged wrapper supplies a pinned downstream `pi-acp` command backed by the pinned Pi build. It owns only singular Pi ACP sessions; the Phenix gateway and orchestration model remain Rust-owned.

ACP is the default backend. The typed Pi JSONL process adapter remains available only through the explicit fallback selector:

```sh
PHENIX_BACKEND=process phenix
```

The fallback remains until real-agent persistence and recovery testing show that removing it is safe. New orchestration behavior belongs in the Rust gateway and must not be added to the JSONL adapter. No second selector or compatibility protocol is retained.

MCP forwarding remains deferred.
