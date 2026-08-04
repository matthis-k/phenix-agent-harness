# Native frontend architecture

Phenix owns the terminal user experience through the existing Rust/Ratatui frontend. Agent harnesses are reached through standard ACP behind a Phenix ACP gateway rather than through frontend-specific backend integrations.

```text
terminal input ─┐
backend events ─┼─ bounded transport ─ routed event fabric ─ reducer/effects ─ render
clock/refresh ──┘

Ratatui frontend
  -> phenix-ui-core
  -> typed Phenix ACP client
  -> Phenix ACP gateway
  -> standard ACP
  -> Pi / Codex / other ACP agents
```

The custom Pi JSONL backend remains a transitional adapter while the standard ACP gateway reaches feature parity. New frontend behavior must target the typed ACP/Phenix interface rather than adding more Pi-specific wire operations.

## Ownership model

The frontend has many producers and addressable reactors, but one authoritative state and render owner. Only the owner loop may mutate `AppState` or invoke the renderer. Producer threads may perform blocking I/O, but they may only send immutable value messages to the event fabric.

Semantic messages are lossless. Refresh and clock messages are explicitly coalescible. Queue saturation must never silently discard user input, ACP events, dialog responses, or lifecycle transitions.

## Two event planes

The frontend separates represented content from presentation behavior.

### Content event bus

The content bus carries facts and lifecycle changes:

- ACP replies, notifications, and typed failures;
- transcript, tool, queue, session, objective, and session-tree changes;
- authentication and elicitation lifecycle;
- workflow and routing state exposed by Phenix ACP;
- clock and refresh events that affect projections.

Content events must not contain terminal geometry, Ratatui widgets, pane sizes, focus transitions, or presentation-specific component references.

### UI event bus

The UI bus carries presentation requests and interaction semantics:

- raw input routed to the focused element;
- focus requests;
- pane resize and visibility requests;
- scrolling;
- overlay and invalidation requests;
- orderly UI shutdown requests.

A pane may react to a content event and emit a UI event. It does not resize itself, mutate application state, or render directly.

### Routed envelopes

Both buses use the same envelope shape:

```text
source: optional ElementId
route: broadcast | focused | exact element | subtree | bubble
payload: ContentEvent or UiEvent
```

`ElementId` is a validated stable identity. Extensions may register additional elements without changing the transport. Reactors receive immutable state and return reactions. The owner loop drains reactions, applies reducers, batches invalidation, and renders once after the resulting transition set.

## Backend and protocol boundary

The frontend depends on a typed client port. It does not depend on Pi, Codex, OpenCode, ACP process details, or backend implementation classes.

The production boundary is:

```text
frontend command
  -> typed ACP or _phenix/* method parameters
  -> serialization
  -> ACP transport
  -> validated response envelope
  -> remote error or typed result decoding
  -> frontend event/reducer
```

Each expected failure stage has a distinct error variant. Serialization, transport, malformed envelopes, correlation failures, remote ACP errors, unsupported capabilities, and result-schema failures must not be collapsed into generic strings.

Standard ACP operations retain their standard request and event types. Phenix-specific orchestration is exposed through negotiated `_phenix/*` methods and notifications. The gateway may aggregate multiple downstream ACP agents while presenting one ACP-compatible endpoint upstream.

## Immutable session-tree configuration

A session tree is an independently configured orchestration domain containing one logical root and all sessions delegated from it. Every session and objective belongs to exactly one tree.

The tree definition is validated and immutable for its lifetime. It selects:

- available ACP backends;
- routing policy;
- workflow registry;
- context and recovery policy;
- MCP servers;
- built-in tool policy.

Operational state remains mutable. A host may run multiple trees with different definitions concurrently. Changing routing, workflows, backends, or tools creates a new tree rather than mutating a running tree.

The frontend may be the composition root that asks the host to create a tree, but it does not execute routing or workflow transitions. Once created, it interacts with the tree through typed ACP and Phenix ACP requests.

## Tool configuration

Client-provided MCP servers are part of immutable tree configuration and are forwarded during downstream ACP session setup. Backend-built-in tool policy is modeled separately because base ACP does not prescribe a universal built-in-tool allow/deny API.

Adapters must either enforce the requested built-in tool policy through advertised ACP configuration or report a typed unsupported-capability error. Silent fallback is forbidden.

## Identity model

Nominal identities must not be interchanged:

- `SessionTreeId`: immutable orchestration-domain identity
- `SessionNodeId`: logical node in a Phenix session graph
- ACP session ID: downstream conversation identity
- `ObjectiveId`: objective graph identity
- `WorkflowId`: workflow definition identity
- `BackendId`: configured downstream ACP endpoint
- `RequestId`: protocol correlation identity
- `ToolCallId`: tool execution identity
- `DialogId`: elicitation or extension-dialog identity
- `AuthFlowId`: authentication-flow identity
- `ElementId`: routed UI identity

Backend session IDs are references owned by node bindings; they are not Phenix node IDs or objective IDs.

## Presentation boundary

The Ratatui frontend owns:

- layout and theme projection;
- pane visibility and sizing;
- focus and input editing;
- transcript and tree rendering;
- overlays, pickers, and dialogs;
- frontend keymaps through the Lua provider.

The gateway owns:

- session-tree authority;
- objective and workflow state;
- backend-agnostic routing;
- downstream ACP session bindings;
- cross-session recovery and health;
- context construction policy.

Downstream ACP agents own their native conversation state, model execution, transcript production, tool execution, authentication, and agent-specific capabilities.

## Testability

Testing is layered:

1. Pure router/reducer tests without ACP, Pi, terminal, or Ratatui.
2. Typed ACP codec tests that distinguish encode, transport, envelope, remote, and result errors.
3. Gateway conformance tests against fake ACP agents.
4. Backend adapter tests against Pi and other agents.
5. Recording-renderer and terminal interaction tests for the Ratatui projection.
6. Packaged end-to-end checks through the gateway.

A frontend interaction test must not require provider credentials or a live model unless explicitly classified as an end-to-end test.

## Extension rules

A new backend-facing operation requires:

1. A standard ACP operation or a namespaced typed Phenix method.
2. Nominal request and response identities where applicable.
3. An explicit capability when support is optional.
4. Exhaustive adapter translation.
5. Separate typed failure modes.
6. Reducer coverage and a deliberate frontend projection.

A new UI producer sends a value-type content or UI envelope. It may not receive mutable state, renderer access, backend objects, or widget references.

## Shutdown

Frontend quit requests orderly gateway/session shutdown but does not immediately terminate the owner loop. The frontend exits only after the backend worker or ACP connection publishes its stopped state, preserving response flushing, session persistence, extension cleanup, and terminal restoration.

## Completion gates

The migration is releasable only when all of these pass:

- Rust formatting, Clippy, workspace tests, and locked Nix build;
- typed ACP and Phenix extension conformance tests;
- routed content/UI bus tests without Pi;
- immutable tree-definition validation and recovery tests;
- standard ACP authentication, sessions, prompts, cancellation, config options, MCP servers, transcript, tool, permission, and elicitation parity;
- Phenix session-tree, objective, routing, workflow, and health extension tests;
- packaged Ratatui-to-gateway-to-Pi initialization and shutdown checks;
- no default invocation of Pi's interactive TUI;
- removal of the transitional custom JSONL protocol after parity.
