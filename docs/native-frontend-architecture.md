# Native frontend architecture

Phenix owns the terminal user experience. Pi remains an internal agent runtime behind a semantic process protocol.

## Ownership model

The Rust frontend has many producers and addressable reactors, but one authoritative state and render owner.

```text
terminal input ─┐
backend output ─┼─ bounded transport ─ routed event fabric ─ reactions ─ owner loop ─ render
clock/refresh ──┘
```

Only the owner loop may mutate `AppState` or invoke the renderer. Producer threads may perform blocking I/O, but they may only send immutable value messages to the event fabric.

Semantic messages are lossless. Refresh and clock messages are explicitly coalescible. Queue saturation must never silently discard user input, backend events, dialog responses, or lifecycle transitions.

## Two event planes

The frontend deliberately separates what is represented from how it is presented.

### Content event bus

The content bus carries facts and lifecycle changes about the represented system:

- runtime replies and failures;
- transcript, tool, queue, run, objective, and session changes;
- authentication and extension-dialog lifecycle;
- clock and refresh events that may affect projections.

Content events must not contain terminal geometry, Ratatui widgets, pane sizes, focus transitions, or presentation-specific component references.

### UI event bus

The UI bus carries presentation requests and interaction semantics:

- raw input routed to the focused element;
- focus requests;
- pane resize requests;
- visibility changes;
- scrolling;
- overlay and invalidation requests;
- orderly UI shutdown requests.

A pane may react to a content event and emit a UI event. For example, the sidebar reactor may observe content growth and emit a resize request addressed to the layout element. The pane does not resize itself and does not render.

### Routed envelopes

Both buses use the same envelope shape:

```text
source: optional ElementId
route: broadcast | focused | exact element | subtree | bubble
payload: ContentEvent or UiEvent
```

`ElementId` is a validated stable identity. Standard addresses include the root, layout, sidebar, transcript, input, status, and overlay elements. Extensions may register additional elements without changing the transport.

A route may be:

- **broadcast** — deliver in deterministic registration order;
- **focused** — begin at the focused element and bubble through its ancestors;
- **exact** — deliver only to one element address;
- **subtree** — deliver to an element and its descendants;
- **bubble** — deliver from an explicit element toward the root.

Multiple reactors may be registered at one address. They run in registration order and may stop propagation after handling an event.

Reactors receive immutable state and an event envelope. They return reactions. They never mutate `AppState`, hold renderer references, or own terminal state.

Reactions may:

- produce an application-state event;
- emit another routed content event;
- emit another routed UI event;
- request a render.

The owner loop drains the reaction queue, applies reducers, batches invalidation, and renders once after the resulting state transition set.

## Testability

Routing and UI wiring are tested independently of Pi.

Pure tests construct:

- an `AppState`;
- an in-memory `EventRouter`;
- fake addressable reactors;
- a recording renderer or command sink.

Tests can then assert:

- exact, broadcast, subtree, focused, and bubbling delivery;
- propagation stopping;
- deterministic ordering of multiple reactors;
- pane-to-layout resize requests;
- focus-sensitive input handling;
- resulting state mutations and render invalidation;
- generated backend commands without launching a backend process.

Pi and the process protocol are covered separately by adapter and end-to-end handshake tests. UI interaction tests must not require Pi, provider credentials, models, or a Node subprocess.

## Backend dependency injection

The composition root injects a `Box<dyn AgentBackend>`. The box is moved into one backend worker; it is not shared through `Arc<Mutex<_>>`.

A backend implementation owns its transport and publishes correlated replies and semantic events. The UI does not branch on backend identity. Optional behavior is described by `BackendCapabilities`.

The Pi implementation is a subprocess adapter:

```text
Ratatui frontend
  -> phenix-runtime-api
  -> phenix-process-backend
  -> JSONL stdin/stdout
  -> TypeScript headless host
  -> AgentSessionRuntime + Phenix domain runtime
```

The process driver alone owns child stdin, child lifecycle, and the pending-request table. Reader and request-forwarder threads feed that driver through an internal channel.

## Identity model

The following identities are intentionally nominal and must not be interchanged:

- `RunId`: live Phenix execution identity
- `ObjectiveId`: user or discovered objective identity
- `SessionId`: persisted Pi session identity
- `SessionEntryId`: persisted conversation-tree entry
- `ToolCallId`: tool execution identity
- `DialogId`: extension UI request identity
- `AuthFlowId`: authentication flow identity
- `RequestId`: transport correlation identity
- `ElementId`: routed UI element identity

Prompts, transcripts, tools, queues, models, and cancellation target runs. Resume, switch, fork, clone, rename, tree, and export operations target persisted sessions. Presentation routing targets elements.

## Presentation boundary

The TypeScript host may emit semantic presentation requests only:

- selection
- confirmation
- text or secret input
- editor input
- notifications
- status values
- string widgets
- working-state metadata

Pi component factories, terminal listeners, custom Pi headers, custom Pi footers, and custom Pi editor implementations do not cross the process boundary. Rust implements equivalent experiences when they are useful.

Theme access in the headless process is render-neutral. Terminal styling and layout are exclusively Rust responsibilities.

## Extension rules

A new backend operation requires:

1. A nominally typed command, reply, or event in `phenix-runtime-api`.
2. An explicit capability when support is optional.
3. Exhaustive TypeScript command routing through an injected port.
4. Wire encoding and decoding tests.
5. Reducer coverage for resulting state transitions.
6. A native interaction or a deliberate non-visual API-only classification.

A new UI producer sends a value-type content or UI envelope. It may not receive mutable state, renderer access, or widget references.

A new reactor registers an `ElementId`, consumes one or both event planes, and emits reactions. It must not apply state changes directly.

A new view stores durable interaction state in `AppState` or `ViewState`. Ratatui widgets remain borrowed projections and must not become hidden controllers.

## Shutdown

`Quit` requests backend shutdown but does not immediately terminate the owner loop. The frontend exits only after the backend worker publishes `Stopped`. This preserves response flushing, extension cleanup, Pi session disposal, and terminal restoration.

## Completion gates

The native frontend is releasable only when all of these pass:

- Rust formatting, Clippy, and workspace tests
- strict TypeScript type checking and headless tests
- routed content/UI bus tests without Pi
- subprocess correlation integration test
- Nix package build with locked Rust dependencies
- packaged Rust-to-Pi initialization and shutdown handshake
- prompt, steering, follow-up, abort, session, model, thinking, authentication, resource, compaction, retry, transcript, tool, and extension-dialog parity checks
- no default invocation of Pi's interactive TUI
