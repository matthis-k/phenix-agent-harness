# Phenix ACP architecture

Phenix uses standard Agent Client Protocol (ACP) for downstream agent sessions and a Rust-owned orchestration layer for state that does not belong in one ACP session.

```text
Lua / Markdown authoring configuration
              |
              v
Rust Phenix definitions, routers, workflows
              |
              v
Immutable Phenix session tree
              |
              v
Phenix conductor / ACP gateway
   root node       -> standard ACP session A
   implementer     -> standard ACP session B
   verifier        -> standard ACP session C
              |
              v
Pi ACP / Codex / other ACP agents
```

A Phenix tree is not represented as one ACP session. Each live Phenix node owns one downstream standard ACP session. The Rust gateway owns tree identity, parentage, objectives, routing, workflows, backend selection, session bindings, subtree cancellation, and shutdown.

## Crate responsibilities

- `phenix-acp`: canonical typed session-tree, routing, workflow, configuration, tool/MCP policy, and `_phenix/*` protocol concepts.
- `phenix-acp-presets`: reusable Phenix definitions, routers, workflows, and credential-free ACP smoke fixtures.
- `phenix-acp-backend`: standard ACP transport through the official `agent-client-protocol` Rust SDK.
- `phenix-conductor`: aggregate standard/Phenix ACP orchestration boundary.
- `phenix-runtime-api`: typed runtime events, commands, replies, and backend/frontend boundary.
- `phenix-tui`: Ratatui frontend; it owns UX and integration, not backend routing/workflow policy.

## Immutable configuration per tree

A `SessionTreeDefinition` is validated and frozen before execution. Multiple independently configured trees may run concurrently, but a running tree does not mutate its routing/workflow configuration in place.

The gateway is assembled before execution:

```rust
let gateway = PhenixAcpGateway::builder()
    .definition(definition)?
    .router(router_id, router)?
    .workflow(workflow_id, workflow)?
    .backend(backend_id, session_factory)?
    .build()?;
```

The builder rejects missing/duplicate registrations and routes to unavailable backends. Workflow plans are validated before downstream sessions are opened.

## Standard ACP and Phenix extensions

Standard ACP remains authoritative for singular-agent behavior: initialization, authentication, session lifecycle, prompts/cancellation, images/streaming, tools/permissions/terminals, and model/session configuration.

Phenix extensions cover orchestration concepts ACP does not model, including session trees, recursive workflow execution, routing explanation, and node-level orchestration.

There is one supported downstream protocol: ACP. The former Pi JSONL/process fallback has been removed; new orchestration behavior belongs in the Rust gateway rather than a compatibility transport.

## Packaged backend

The packaged `phenix` application supplies pinned `pi-acp` and Pi executables as one available downstream ACP agent implementation. `pi-acp` owns singular Pi sessions only. Phenix tree/routing/workflow/frontend authority remains in Rust.

The repository does not maintain Pi TUI patches, an in-repository Pi extension application, or a second process protocol.

## Verification

Mechanical normalization is applied through `maintenance:fix` (and automatically on same-repository pull requests). Validation then runs the committed source explicitly:

```text
cargo fmt --all --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
nix flake check --print-build-logs --keep-going
```

The packaged `phenix-acp-smoke` path uses credential-free ACP fixtures so the gateway and frontend packaging can be checked without production credentials.
