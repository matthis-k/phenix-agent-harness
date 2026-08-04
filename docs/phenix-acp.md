# Phenix ACP architecture

Phenix uses standard Agent Client Protocol (ACP) as its backend-facing contract and adds a negotiated Phenix extension profile for orchestration state that does not belong in base ACP.

```text
Ratatui / Neovim / web frontend
                |
                | ACP + _phenix/* extensions
                v
        Phenix ACP gateway
                |
                | standard ACP
                v
       Pi / Codex / other agents
```

Phenix ACP is not a fork of ACP. Standard ACP requests, responses, notifications, capability negotiation, authentication, sessions, prompt turns, tool calls, permissions, and configuration remain standard ACP. A generic ACP client can connect to the gateway and use those base features without understanding Phenix extensions.

## Crate responsibilities

`phenix-acp` provides mechanisms only:

- validated nominal identities;
- typed Phenix extension methods;
- immutable session-tree definitions;
- typed backend endpoint definitions;
- typed request/result association;
- staged request, transport, envelope, remote, and result-decoding errors;
- tool configuration policy shared by all backend adapters.

`phenix-acp-presets` provides policy:

- the standard Phenix backend definition;
- the capability/budget router selection;
- standard workflow registrations;
- reusable local-only or purpose-specific tree definitions.

The core crate must never depend on the presets crate.

## Immutable configuration per session tree

A session tree is one independently configured orchestration domain containing one logical root and all sessions delegated from it. Every session and objective belongs to exactly one tree.

A `SessionTreeDefinition` is validated and frozen before a tree starts. It contains:

- allowed ACP backends;
- router identity;
- workflow definitions;
- context and recovery policy references;
- MCP server declarations;
- built-in tool policy.

Operational state changes while the definition does not. Creating sessions, completing objectives, receiving transcript updates, and recovering failed backend connections are state transitions. Replacing routing, workflows, tools, or backend definitions requires a new session tree.

One host may run several trees with different definitions concurrently. Host services such as logging, process supervision, executable discovery, and credential storage may be shared explicitly, while tree policy and session state remain isolated.

## Typed method boundary

Every request marker associates exactly one parameter type with one result type:

```rust
pub trait AcpMethod {
    const METHOD: &'static str;
    type Params: serde::Serialize;
    type Result: serde::de::DeserializeOwned;
}
```

The call path keeps failures distinct:

```text
typed params
  -> request serialization error
  -> transport error
  -> response-envelope decoding error
  -> correlation/version error
  -> typed remote ACP error
  -> typed result-decoding error
  -> typed result
```

Expected failure modes must not be collapsed into an arbitrary string or a generic protocol error. Invalid identifiers and invalid immutable definitions are rejected during construction and deserialization.

The local codec in `phenix-acp` establishes this invariant for Phenix extension messages. The production standard-ACP transport will use the official `agent-client-protocol` Rust SDK rather than duplicating the ACP schema or connection state machine.

## Phenix extension methods

Initial typed methods use ACP's custom-method naming convention:

```text
_phenix/session_tree/create
_phenix/session_tree/get
_phenix/session_tree/list
_phenix/workflow/start
_phenix/routing/explain
```

The gateway will also publish revisioned notifications for tree, objective, workflow, routing, and runtime-health changes. Large authoritative state is returned through typed methods; `_meta` is reserved for annotations and correlation data.

## Tools

ACP session setup supports client-provided MCP servers. A tree definition therefore carries typed stdio, HTTP, or SSE MCP server declarations that the gateway supplies when it creates, loads, or resumes downstream ACP sessions.

ACP does not define one universal allow/deny mechanism for every agent's built-in tools. Phenix therefore models built-in tool policy separately:

```text
backend_default
all disabled
allow only { ... }
deny { ... }
```

Each backend adapter must report whether it can enforce that policy and translate it through stable ACP session configuration options or backend-specific configuration. Unsupported non-default policy is an explicit capability error; it must not be silently ignored.

MCP-over-ACP is a draft extension in the official Rust SDK. When stabilized, it can allow the Phenix gateway to provide in-process or proxy-provided MCP tools over the existing ACP connection without spawning a separate MCP transport. Until then, stable session-provided MCP server configuration is the default.

## Frontend boundary

The existing Ratatui frontend remains a state projection and interaction layer. It owns layout, focus, panes, input, overlays, and rendering. It does not execute workflows or routing policy.

The intended dependency direction is:

```text
phenix-tui
  -> phenix-ui-runtime
  -> phenix-ui-core
  -> phenix-acp client facade
  -> Phenix ACP gateway
  -> standard ACP backend connections
```

The current custom Pi JSONL adapter remains transitional until standard ACP event and request parity is wired through the official SDK. UI components must not branch on Pi or any other backend identity.

## Migration order

1. Land validated Phenix ACP extension types and immutable tree definitions.
2. Integrate the official Rust ACP SDK behind a typed gateway/client adapter.
3. Translate standard ACP snapshots and notifications into the existing frontend state reducer.
4. Move Pi behind a downstream ACP adapter while retaining the Ratatui UI unchanged.
5. Move routing, workflows, objectives, and session-tree authority into the gateway.
6. Port the standard Phenix policies into `phenix-acp-presets`.
7. Remove the transitional custom Pi JSONL protocol after parity and recovery tests pass.
