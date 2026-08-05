# Phenix ACP architecture

Phenix uses standard Agent Client Protocol (ACP) for downstream agent sessions and a Rust-owned orchestration gateway for state that does not belong in a singular ACP session.

```text
TypeScript / Lua configuration
            |
            v
Rust Phenix definitions, routers, and workflows
            |
            v
Immutable Phenix session tree
            |
            v
Rust Phenix ACP gateway
   root node       -> standard ACP session A
   implementer     -> standard ACP session B
   verifier        -> standard ACP session C
            |
            v
Pi / Codex / other ACP agents
```

A complete Phenix tree is not represented as one ACP session. Each live Phenix node owns exactly one downstream standard ACP session. The Rust gateway owns tree identity, parentage, objectives, routing, workflows, backend selection, session bindings, subtree cancellation, and tree shutdown.

## Crate responsibilities

`phenix-acp` provides the canonical mechanisms:

- validated nominal identities;
- immutable session-tree definitions;
- `PhenixAcpGateway` and its builder;
- typed router, workflow, backend-factory, and session interfaces;
- typed new/load/resume/fork lifecycle operations;
- typed Phenix extension methods and host envelopes;
- staged configuration, transport, protocol, and decoding errors;
- shared tool and MCP configuration policy.

`phenix-acp-presets` provides reusable policy:

- the standard Phenix definition;
- standard router registration;
- executable implement, QA, QA-fix, and dynamic workflows;
- reusable local-only definitions;
- the packaged credential-free ACP gateway smoke binary.

`phenix-acp-backend` owns standard ACP transport through the official `agent-client-protocol` Rust SDK. It maps authentication, persistence, prompts, images, steering, follow-ups, compaction, tools, permissions, terminals, models, modes, thinking levels, and notifications into the typed Phenix runtime model.

`phenix-tui` is a frontend. It owns rendering, layout, focus, panes, input, and overlays; it does not own routing or workflow semantics.

## Immutable configuration per tree

A `SessionTreeDefinition` is validated and frozen before execution. It declares the allowed backends, router, workflows, tools, and related policy references. Operational state changes while the definition remains immutable.

Multiple independently configured trees can run concurrently in one process. Shared host services may be injected explicitly, but no running tree can have its routing or workflow configuration mutated in place.

## Builder boundary

The gateway is assembled before execution:

```rust
let gateway = PhenixAcpGateway::builder()
    .definition(definition)?
    .router(router_id, router)?
    .workflow(workflow_id, workflow)?
    .backend(backend_id, session_factory)?
    .build()?;
```

The builder rejects missing or duplicate registrations. A router cannot select a backend outside the immutable definition. Workflow plans are validated as topologically ordered trees before any downstream sessions are opened.

`WorkflowPlanBuilder` is the declarative recursive-plan API. Routers and workflows remain executable typed Rust interfaces rather than unchecked string commands.

## Standard ACP and Phenix extensions

Standard ACP remains authoritative for singular-agent behavior:

- initialization and capability negotiation;
- authentication;
- session creation, loading, resumption, forking, and closing;
- prompts and cancellation;
- images and streaming content;
- tools, permissions, and terminal delegation;
- model, mode, thinking, and session configuration.

Phenix extensions cover orchestration concepts that standard ACP intentionally does not define:

```text
_phenix/session_tree/create
_phenix/session_tree/get
_phenix/session_tree/list
_phenix/workflow/start
_phenix/routing/explain
```

The serializable `GatewayCommand`, `GatewayReply`, and `GatewayEnvelope` types provide the host boundary for TypeScript, Lua, and future frontend bindings. Those hosts configure or invoke the Rust gateway; they do not reimplement ACP transport or orchestration.

## Ratatui integration

The Ratatui ACP backend owns a `PhenixAcpGateway` and a shared tree transport. One ACP process connection is shared per Phenix tree, and each node receives its own singular ACP session handle on that connection.

Frontend operations are translated into gateway operations:

- create/load/resume/fork creates typed Phenix nodes;
- prompts, images, steering, follow-ups, compaction, model changes, mode changes, thinking changes, and advertised commands target the selected node;
- cancellation propagates through the selected subtree;
- gateway parentage, objectives, state, and downstream session bindings are projected into the frontend runtime snapshot.

Authentication may complete before a usable root session exists. Once the downstream agent exposes one, the adapter creates the stable root tree and binds that session to the root node.

## Packaged default and fallback

The packaged `phenix` wrapper supplies a pinned `pi-acp` command backed by the pinned Pi build. This adapter is only the downstream singular-session ACP agent; the Phenix session-tree gateway, routing, workflows, and frontend authority remain Rust-owned.

ACP is the default backend. The typed Pi JSONL adapter remains available only through the explicit fallback selector:

```sh
PHENIX_BACKEND=process phenix
```

The fallback remains until real-agent persistence and recovery testing demonstrate that removing it is safe. New orchestration behavior must be implemented in the Rust gateway, never in the JSONL path. No second selector or compatibility protocol is maintained.

## Verification

The Rust verification gate is read-only and runs committed source directly:

```text
cargo fmt --all --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
```

The packaged `phenix-acp-smoke` binary uses the official Rust SDK on both sides. It starts a credential-free stdio fixture, constructs the standard gateway, creates a tree, verifies the root-to-ACP-session binding, completes a prompt, closes the tree, and verifies teardown. The Nix frontend smoke executes this binary as part of repository verification.

MCP forwarding remains deliberately deferred.
