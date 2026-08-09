# Phenix ACP conductor runtime

A complete Phenix run tree is not a singular ACP session. The canonical application boundary is the `phenix-conductor` ACP server; the in-process gateway is its implementation machinery, not an alternate frontend protocol.

```text
frontend
  -> standard ACP + _phenix/*
phenix-conductor
  -> PhenixAcpGateway / aggregate state
  -> ordinary ACP client transport
ACP agent
```

## Ownership model

The conductor owns configuration revisions and the mapping from each tree to the immutable revision under which it was created. Within one revision, `PhenixAcpGateway` owns tree/node identity, parentage, objectives, workflow expansion, routing, difficulty, full model configuration, node-to-session bindings, subtree cancellation and shutdown.

Every live node owns one downstream standard ACP session. The downstream agent remains authoritative for execution inside that singular session.

## Configuration and policy

The gateway builder is an internal mechanism for atomically materializing one validated user-supplied configuration revision:

```rust
let gateway = PhenixAcpGateway::builder()
    .definition(definition)?
    .router(router_id, router)?
    .workflow(workflow_id, workflow)?
    .backend(backend_id, session_factory)?
    .build()?;
```

Nothing is registered implicitly. `build()` rejects incomplete or internally inconsistent user configuration. Workflow plans are validated before nodes are committed.

Applying another configuration creates another runtime revision; it does not mutate the gateway serving an existing tree.

## Session lifecycle

Backend factories receive explicit `SessionOpenKind` values for new, load, resume and fork operations. A `SessionOpenRequest` also carries the routed difficulty and complete model configuration (`backend/provider/model/thinking`). The ACP adapter applies both model and thinking selection to the downstream session.

Standard ACP sessions cover prompts, images, steering/follow-ups, compaction, cancellation, rename/model/mode/thinking changes, advertised commands, polling and close. Streamed tool/transcript/terminal/permission/completion events are projected into typed Phenix aggregate events.

## Frontend integration

The Ratatui frontend does not construct `PhenixAcpGateway`, own downstream ACP processes, or call a direct gateway adapter. It starts/connects to a bare conductor, sends the user-authored `_phenix/config/apply` request over ACP, then uses the conductor endpoint.

This keeps the frontend replaceable: another frontend can use the same Phenix ACP API without Lua, Ratatui or the Rust frontend runtime types.

## Internal host types

`GatewayCommand`, `GatewayReply` and related serializable types are useful internal/test host representations. They are not the canonical application boundary. The canonical public boundary is standard ACP plus typed `_phenix/*` methods implemented by the conductor.

## Packaged verification

Credential-free ACP fixtures exercise configuration, tree creation, full route selection, downstream session binding, prompt completion and teardown. Nix frontend smoke uses an explicitly configured test package; the ordinary `phenix` package does not inject sample routing/workflow policy when user configuration is absent.

## Downstream agents

The package may make `pi-acp` and other ACP implementations available as executables, but availability is not selection. A backend only participates after user configuration registers it. Supporting another agent means configuring another ACP backend, not creating a parallel frontend transport.
