# Rust/Ratatui frontend migration

## Objective

Phenix owns the complete terminal experience in Rust. Pi remains a headless TypeScript runtime
adapter until another backend reaches feature parity. No Pi TUI component, renderer, editor, picker,
header, footer, or theme crosses the boundary.

The migration preserves relevant Pi behavior:

- prompt, steering, follow-up, interruption, retry, and compaction;
- persistent sessions, switching, trees, forks, clones, import, and export;
- providers, model selection, thinking levels, and Phenix virtual models;
- OAuth, API-key, browser callback, device-code, manual-code, logout, and credential status;
- tools, extensions, hooks, skills, prompt templates, commands, and resource reload;
- semantic extension dialogs, notifications, status contributions, and editor requests;
- streaming transcript, reasoning, tool, queue, health, usage, and failure events.

Presentation-only Pi APIs are replaced rather than transported.

## Dependency direction

```text
phenix-tui (future Ratatui renderer)
        |
        v
phenix-ui-core
        |
        v
phenix-runtime-api
        ^
        |
boxed AgentBackend injected at the composition root
        ^
        |
Pi JSONL adapter initially; other adapters may follow
```

The protocol is a Phenix capability model. It does not serialize Pi classes or Pi TUI components.
Backends declare supported capabilities, so missing behavior is explicit and testable.

## Rust-native patterns

### Backend ownership

The composition root injects `Box<dyn AgentBackend>`. The box is moved exactly once into a dedicated
driver thread. The UI receives a cloneable request client and an event receiver.

This deliberately avoids `Arc<Mutex<Box<dyn AgentBackend>>>`. Holding a mutex guard over blocking
I/O or an async suspension point would create unnecessary contention, cancellation hazards, and
poisoning semantics. A single owner plus bounded message passing expresses the actual runtime
relationship directly.

`AgentBackend::run` consumes `Box<Self>`. It therefore cannot be called concurrently or retained by
the UI accidentally. Backend implementations own their subprocesses, protocol decoder, pending
request table, and shutdown sequence inside that driver.

### Reducer and effects

`AppState` is owned by one frontend event loop. `reduce(&mut AppState, AppEvent)` returns explicit
`AppEffect` values. Rendering receives `&AppState`; it does not call the backend or mutate runtime
state.

Owned commands and events cross threads. Borrowed views remain local to rendering. This follows
Rust's ownership model more closely than an observer graph containing shared mutable controllers.

### Stable identity and collections

Durable backend identities use validated string newtypes because their values must survive process
restarts and cross the TypeScript boundary. Generational arena keys are suitable only for ephemeral
render objects and must not replace durable session, run, dialog, or tool-call IDs.

The core uses standard `BTreeMap`, `Vec`, and `VecDeque`. Persistent collections, arenas, or intrusive
trees should be added only where profiling or concrete ownership constraints justify them.

### Secrets

Secret authentication responses use a redacted `SecretValue` backed by bytes. Debug output never
contains the value and the buffer is overwritten on drop. Secret values must not enter reducer
history, diagnostics, transcript blocks, or generic JSON logging.

## Transport boundary

The Pi adapter will run `AgentSessionRuntime` in a Node process. Commands and events use strict JSONL
framing over piped stdin/stdout initially. Rust owns the terminal, so the child process never enters
raw mode.

The adapter is responsible for translating Pi behavior into the semantic protocol:

- Pi `AgentSessionEvent` to transcript/tool/queue/lifecycle events;
- `ModelRuntime` authentication callbacks to typed authentication prompts and notices;
- extension UI calls to semantic dialog and status requests;
- session replacement to snapshots and session-tree changes;
- typed Phenix workspace snapshots, objectives, memory, diagnostics, and child runs.

The transport must validate external JSON as untrusted input before constructing domain values.
One current protocol is maintained; compatibility variants are not retained in the pre-release
repository.

## Migration sequence

1. **Core boundary** — land the Rust protocol, boxed backend driver, reducer, ownership tests, and CI.
2. **Pi process adapter** — add strict JSONL envelopes, correlation, bounded queues, restart/failure
   semantics, and TypeScript schema validation.
3. **Functional parity** — expose login/logout, models, sessions, commands, resources, compaction,
   retry, extension dialogs, and complete Phenix workspace snapshots.
4. **Ratatui shell** — implement transcript, editor, sidebar, dialogs, command palette, model picker,
   login flow, status line, and mouse/keyboard routing entirely in Rust.
5. **Cutover** — package one `phenix` command, retain Pi interactive mode only as a diagnostic escape
   hatch, and remove the Pi TUI overlay implementation.
6. **Alternative backend gate** — evaluate Goose or another backend only against the same capability
   and parity suite; no UI rewrite is permitted for a backend change.

## Acceptance criteria

- the Rust process is the only owner of stdin, stdout, raw mode, terminal title, and clipboard UI;
- all backend dependencies are injected at the composition root;
- no backend-specific type appears in `phenix-ui-core`;
- protocol unions and reducers are exhaustively matched;
- malformed frames, unknown variants, backend exit, and interrupted auth flows become typed failures;
- restoring a root restores its complete Phenix run/session projection;
- `/login`, `/logout`, `/model`, `/settings`, `/resume`, `/fork`, `/compact`, and extension commands
  use native Rust surfaces;
- the existing TypeScript frontend remains available during migration but receives no new features.
