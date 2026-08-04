# Native frontend architecture

Phenix owns the terminal user experience. Pi remains an internal agent runtime behind a semantic process protocol.

## Ownership model

The Rust frontend uses one state-owning event loop.

```text
terminal input ─┐
backend output ─┼─ bounded MPSC mailbox ─ owner loop ─ reducer/effects ─ renderer
clock/refresh ──┘
```

Only the owner loop may mutate `AppState` or invoke the renderer. Producer threads may perform blocking I/O, but they may only send immutable value messages to the mailbox.

Semantic messages are lossless. Refresh and clock messages are explicitly coalescible. Queue saturation must never silently discard user input, backend events, dialog responses, or lifecycle transitions.

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

Prompts, transcripts, tools, queues, models, and cancellation target runs. Resume, switch, fork, clone, rename, tree, and export operations target persisted sessions.

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

A new UI producer requires a value-type `UiMessage` path into the mailbox. It may not receive mutable state, renderer access, or widget references.

A new view stores durable interaction state in `AppState` or `ViewState`. Ratatui widgets remain borrowed projections and must not become hidden controllers.

## Shutdown

`Quit` requests backend shutdown but does not immediately terminate the owner loop. The frontend exits only after the backend worker publishes `Stopped`. This preserves response flushing, extension cleanup, Pi session disposal, and terminal restoration.

## Completion gates

The native frontend is releasable only when all of these pass:

- Rust formatting, Clippy, and workspace tests
- strict TypeScript type checking and headless tests
- subprocess correlation integration test
- Nix package build with locked Rust dependencies
- packaged Rust-to-Pi initialization and shutdown handshake
- prompt, steering, follow-up, abort, session, model, thinking, authentication, resource, compaction, retry, transcript, tool, and extension-dialog parity checks
- no default invocation of Pi's interactive TUI
