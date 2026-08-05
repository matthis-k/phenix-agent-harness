# Phenix ACP server

The packaged `phenix` frontend now starts the Pi compatibility backend as a stable ACP v1 agent. The server uses the official `@agentclientprotocol/sdk` transport and keeps Pi-specific execution behind the existing typed headless executor facade.

## Transport selection

ACP is the default transport. The legacy newline-delimited headless protocol remains available for diagnostics and migration:

```sh
PHENIX_HEADLESS_TRANSPORT=jsonl phenix
# or invoke the headless entry with --transport=jsonl
```

The two transports share one executor and event source. Session, prompt, model, authentication, compaction, command, and extension-UI behavior therefore cannot drift between independent backend implementations.

## Standard ACP projection

The adapter maps:

- session creation, loading, resuming, listing, cloning, and cancellation;
- text and image prompts;
- assistant text, thought chunks, and tool-call lifecycle updates;
- advertised slash commands;
- model and thinking configuration through ACP session configuration options;
- selected persistent-branch transcript replay during `session/load`.

## Phenix extensions

Phenix orchestration remains namespaced under `_phenix/*`:

- `_phenix/session_tree/create`
- `_phenix/session_tree/get`
- `_phenix/session_tree/list`
- `_phenix/workflow/start`
- `_phenix/routing/explain`

The session-tree projection includes recursive runs and objectives. The adapter also emits `_phenix/event` and `_phenix/snapshot` notifications for clients that need the complete Phenix state model.

MCP forwarding remains deferred.
