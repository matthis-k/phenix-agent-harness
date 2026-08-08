# Phenix ACP gateway runtime

The Phenix ACP boundary is implemented in Rust. A complete Phenix run tree is not a singular ACP session.

## Ownership model

A `PhenixAcpGateway` owns independently configured session trees. Each tree is created from a validated immutable `SessionTreeDefinition`; every live session node owns one downstream standard ACP session.

The gateway is authoritative for tree/node identity, parentage, objectives, workflow expansion, routing, backend/model selection, node-to-session bindings, subtree cancellation, and shutdown. The downstream agent remains authoritative for execution inside its singular ACP session.

## Builder boundary

```rust
let gateway = PhenixAcpGateway::builder()
    .definition(definition)?
    .router(router_id, router)?
    .workflow(workflow_id, workflow)?
    .backend(backend_id, session_factory)?
    .build()?;
```

`build()` rejects missing/duplicate registrations and invalid routes. Workflow plans are validated before nodes are committed.

## Session lifecycle

Backend factories receive explicit `SessionOpenKind` values for new, load, resume, and fork operations. Standard ACP sessions cover prompts, images, steering/follow-ups, compaction, cancellation, rename/model/mode/thinking changes, advertised commands, polling, and close. Streamed tool/transcript/terminal/permission/completion events are projected into typed Phenix runtime events.

## Frontend integration

The Ratatui frontend talks to the Rust gateway through typed runtime state. Creating/loading/resuming/forking sessions creates typed Phenix nodes; interactive actions target the selected node; cancellation propagates through the selected subtree; and gateway parentage/state/session bindings are projected into the frontend snapshot.

Projection fails explicitly when a downstream session cannot be mapped to a Phenix node. It does not invent detached compatibility state.

## Host boundary

`GatewayCommand`, `GatewayReply`, and related serializable types provide the host boundary. Lua supplies authoring/configuration data but does not reimplement transport, routing, or orchestration.

## Packaged verification

The packaged `phenix-acp-smoke` binary uses credential-free ACP fixtures to exercise tree creation, downstream session binding, prompt completion, and teardown. Nix frontend smoke checks execute this path as part of `nix flake check`.

## Downstream agents

The packaged application includes pinned `pi-acp` + Pi as one downstream ACP implementation. There is no JSONL/process fallback or `PHENIX_BACKEND` selector. Supporting another agent means adding/configuring another ACP backend, not creating a parallel frontend transport.

MCP forwarding remains a separate capability and should be implemented through the typed ACP/configuration boundaries when enabled.
