# Native frontend architecture

Phenix owns the terminal user experience through the Rust/Ratatui frontend. The frontend is a client of the Phenix conductor; it does not construct orchestration runtime state itself.

```text
terminal input ─┐
backend events ─┼─ bounded transport ─ routed event fabric ─ reducer/effects ─ render
clock/refresh ──┘

Ratatui frontend
  -> phenix-ui-core
  -> phenix-runtime-api
  -> ACP client adapter
  -> phenix-conductor (standard ACP + _phenix/*)
  -> ordinary ACP client sessions
  -> Pi / Codex / other ACP agents
```

There is one production orchestration boundary: the conductor ACP server. A frontend does not call `PhenixAcpGateway` directly and there is no frontend-specific process protocol fallback.

## Ownership model

The frontend has many producers and addressable reactors, but one authoritative state and render owner. Only the owner loop may mutate `AppState` or invoke the renderer. Producer threads may perform blocking I/O, but they may only send immutable value messages to the event fabric.

The backend runtime also has one owner. A boxed `AgentBackend` is moved into its driver thread and communicates through bounded request and event channels. Backend objects are not shared through `Arc<Mutex<_>>`, and frontend code cannot retain or invoke them directly.

Semantic messages are lossless. Refresh and clock messages are explicitly coalescible. Queue saturation must never silently discard user input, ACP events, dialog responses, or lifecycle transitions.

## Two event planes

The frontend separates represented content from presentation behavior.

### Content event bus

The content bus carries facts and lifecycle changes:

- ACP replies, notifications, and typed failures;
- transcript, tool, queue, session, objective, and session-tree changes;
- authentication and elicitation lifecycle;
- workflow, difficulty and routing state exposed by the conductor;
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

The frontend depends on the typed runtime API and the ACP client adapter. It does not depend on Pi, Codex, OpenCode, downstream ACP process details, or conductor implementation classes.

The production path is:

```text
frontend authoring/config
  -> typed _phenix/config/apply over ACP
  -> conductor-owned immutable configuration revision

frontend operation
  -> typed runtime command
  -> standard ACP or typed _phenix/* request
  -> phenix-conductor
  -> aggregate tree operation
  -> standard ACP request for one downstream session
  -> validated ACP reply/notification
  -> typed runtime event
  -> frontend reducer
```

Expected failure stages remain distinct. Configuration, serialization, transport, malformed protocol data, remote ACP errors, unsupported capabilities, and projection failures must not be collapsed into undifferentiated strings.

Standard ACP operations retain standard request and event types. Phenix-specific orchestration uses namespaced typed `_phenix/*` methods. The in-process gateway types are conductor implementation details, not an alternative frontend API.

## Configuration ownership

A fresh conductor is unconfigured. The frontend may use Lua and local definition files as an authoring surface, but it sends source descriptors to the conductor through `_phenix/config/apply`; it does not parse those sources into gateway state or start downstream agents itself.

Applying configuration creates an immutable conductor-owned revision. A later configuration apply creates a new revision for future trees. Existing trees remain bound to the revision under which they were created.

Reusable configuration contains:

- available ACP backends;
- routing tables;
- workflow definitions;
- MCP server declarations;
- built-in tool policy;
- other reusable orchestration policy.

Concrete tree instance data is separate. Root role, difficulty, objective, and optional requested tree identity belong to tree creation. The optional `standard_session` authoring field is only a compatibility template for translating ordinary ACP `session/new` into a Phenix tree.

## Difficulty and routing

Difficulty is explicit runtime state with levels `D0` through `D4`. A routing rule contains one complete model configuration per level. Every routing cell is the atomic tuple:

```text
backend/provider/model/thinking
```

The conductor does not invent a missing backend, provider, model, or thinking level. Delegated work inherits the current difficulty unless the caller explicitly overrides it.

## Tool configuration

Client-provided MCP servers are part of user-owned immutable configuration and are forwarded during downstream ACP session setup when supported. Backend-built-in tool policy is modeled separately because base ACP does not prescribe a universal built-in-tool allow/deny API.

Adapters must either enforce requested tool policy through advertised ACP configuration or report a typed unsupported-capability error. Silent fallback is forbidden.

## Identity model

Nominal identities must not be interchanged:

- `SessionTreeId`: orchestration-domain identity
- `SessionNodeId`: logical node in a Phenix session graph
- ACP session ID: downstream conversation identity
- `ObjectiveId`: objective graph identity
- `WorkflowId`: workflow definition identity
- `BackendId`: configured downstream ACP endpoint
- `RequestId`: runtime correlation identity
- `ToolCallId`: tool execution identity
- `DialogId`: elicitation or extension-dialog identity
- `AuthFlowId`: authentication-flow identity
- `ElementId`: routed UI identity

Backend session IDs are references owned by node bindings; they are not Phenix node IDs or objective IDs.

## Secret handling

Secret authentication responses use a redacted `SecretValue` backed by mutable bytes. Debug output never contains the value, and the buffer is overwritten on drop. Secret values must not enter reducer history, diagnostics, transcript blocks, generic JSON logging, or persisted frontend state.

Authentication prompts and external terminal-login flows are represented by typed lifecycle events. Cancellation of one prompt or terminal command must not implicitly cancel the complete session tree.

## Presentation boundary

The Ratatui frontend owns:

- layout and theme projection;
- pane visibility and sizing;
- focus and input editing;
- transcript and tree rendering;
- overlays, pickers, and dialogs;
- frontend keymaps through the Lua provider.

The conductor owns:

- configuration revisions;
- session-tree authority;
- objective and workflow state;
- difficulty-aware backend/model/thinking routing;
- downstream ACP session bindings;
- subtree cancellation and tree shutdown;
- cross-session recovery and health;
- aggregate context/orchestration state.

Downstream ACP agents own their native conversation state, model execution, transcript production, tool execution, authentication, and agent-specific capabilities.

## Testability

Testing is layered:

1. Pure router, reducer, parser and projection tests without a live agent or terminal.
2. Typed ACP/Phenix codec tests distinguishing encoding, transport, protocol, remote, and result errors.
3. Conductor conformance tests against fake ACP agents.
4. Downstream ACP adapter tests.
5. Recording-renderer and interaction tests for the Ratatui projection.
6. Packaged end-to-end checks through frontend -> conductor -> credential-free ACP fixture.

A frontend interaction test must not require provider credentials or a live model unless explicitly classified as an end-to-end test.

## Extension rules

A new backend-facing operation requires:

1. A standard ACP operation or a namespaced typed Phenix method.
2. Nominal request and response identities where applicable.
3. An explicit capability when support is optional.
4. Exhaustive adapter translation.
5. Separate typed failure modes.
6. Reducer coverage and a deliberate frontend projection.

A new UI producer sends a value-type content or UI envelope. It may not receive mutable state, renderer access, conductor/gateway objects, backend objects, or widget references.

## Shutdown

Frontend quit requests orderly conductor/session shutdown but does not immediately terminate the owner loop. The frontend exits only after the backend worker or ACP connection publishes its stopped state, preserving response flushing, session persistence, extension cleanup, and terminal restoration.

## Verification

Every change to this path must preserve:

- Rust formatting, Clippy, workspace tests, and locked Nix builds;
- typed standard ACP and Phenix extension conformance tests;
- routed content and UI bus tests without a live model;
- immutable configuration-revision and workflow-plan validation;
- standard ACP authentication, sessions, prompts, cancellation, configuration, transcript, tool, permission, terminal, and image behavior;
- Phenix session-tree, objective, difficulty, routing, workflow, and health projection tests;
- packaged Ratatui -> conductor -> agent initialization and shutdown checks;
- no implicit selection of sample workflows, routers, roles, backends, models or thinking policy;
- read-only CI that rejects generated or unformatted source.
