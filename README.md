# Phenix Agent Harness

Phenix is an ACP-native agent harness built around a **headless conductor** and a **Neovim frontend**.

The conductor owns orchestration. Neovim owns interaction. The project is under active architectural development; prefer the current typed Rust/ACP implementation over compatibility layers or historical APIs.

## Architecture

```text
                         Phenix

       Neovim frontend                         orchestration core
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ phenix-nvim                  │       │ phenix-conductor             │
│                              │       │                              │
│ native sidebar windows       │ ACP   │ Phenix ACP server            │
│ transcript + prompt buffer   ├──────►│ configuration revisions      │
│ one persistent ACP session   │       │ session trees + objectives   │
│ plain text projection        │       │ routing + workflows          │
└──────────────────────────────┘       └──────────────┬───────────────┘
                                                     │ standard ACP
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │ Pi / Codex / other ACP agent │
                                      └──────────────────────────────┘
```

The boundary is intentionally narrow:

> **The conductor owns orchestration. Neovim owns editor behavior. `phenix-nvim` only bridges semantic agent interaction into native editor primitives.**

A frontend may author configuration and request operations, but it must not become a second implementation of routing, workflows, session-tree state, or downstream agent management.

## Conductor

`phenix-conductor` is the headless runtime and canonical application boundary.

It owns:

- immutable configuration revisions;
- Phenix session-tree and node identity;
- objectives and workflow state;
- difficulty-aware routing to complete backend/provider/model/thinking configurations;
- downstream ACP session bindings;
- aggregate lifecycle, cancellation, recovery, and health state;
- typed Phenix extensions for concepts that standard ACP does not represent.

Northbound, the conductor exposes standard ACP plus typed `_phenix/*` extensions. Southbound, it is an ordinary ACP client. A Phenix session tree can therefore aggregate several ordinary ACP sessions without inventing another agent protocol.

The conductor is mechanism, not policy. It validates and executes user-supplied backends, routing tables, workflows, and tool policy; it does not silently install repository examples, preferred models, roles, or workflows.

## Neovim frontend

`phenix-nvim` is the interactive frontend under [`nvim/`](nvim/). The first implementation is deliberately minimal.

`require("phenix").setup()` installs `<leader>pp` by default. It toggles a right-hand sidebar containing:

- a plain transcript buffer on top;
- a normal editable prompt buffer below it.

Type one prompt and press `<CR>`, or `:write` the prompt buffer, to submit it. The transcript currently projects only submitted user text, streamed assistant text, and errors. Thinking, tool calls, plans, rich rendering, follow-up controls, steering controls, model pickers, and other richer surfaces are intentionally deferred.

The ACP process and standard session are **not** tied to sidebar visibility. Hiding the sidebar keeps `phenix-conductor`, the ACP session, the transcript, and the input buffer alive. Toggling it again recreates the windows around the same state. The session stops only on `require("phenix").shutdown()` or Neovim exit.

The public command surface is intentionally small:

```vim
:PhenixToggle [cwd]
```

The Lua surface is correspondingly small:

```lua
local phenix = require("phenix")

phenix.setup()
phenix.toggle({ cwd = vim.fn.getcwd() })
phenix.current()
phenix.shutdown()
```

The frontend does not reimplement text editing, cursor movement, Vim modes, terminal-cell rendering, a pane/layout engine, workflow execution, routing decisions, or authoritative session state.

The packaged `phenix` executable supplies the packaged conductor, plugin runtime path, and example configuration. The plugin can also be consumed directly from an existing Neovim configuration.

The plugin package is exported both as `packages.<system>.phenix-nvim` and through the traditional Nixpkgs plugin namespace as `legacyPackages.<system>.vimPlugins.phenix-nvim`. Consumers that apply this flake's default overlay can use `pkgs.vimPlugins.phenix-nvim` directly.

## Configuration

A fresh conductor is unconfigured. The frontend submits authored configuration through `_phenix/config/apply` before creating the standard interactive ACP session.

The repository configuration under [`config/phenix-harness/`](config/phenix-harness/) remains the explicit example/authoring configuration. Its `phenix.acp.*` Lua calls are evaluated by the Neovim plugin and converted into the same typed conductor configuration input. Lua is therefore an authoring surface, not a second orchestration runtime.

Applying configuration creates an immutable revision. New session trees use the active revision; existing trees remain pinned to the revision under which they were created.

See [`docs/frontend-lua.md`](docs/frontend-lua.md) for the authoring and plugin API.

## Rust boundaries

The Rust workspace contains only headless protocol/orchestration machinery:

| Crate | Responsibility |
| --- | --- |
| `phenix-acp` | Canonical Phenix protocol/domain types, source parsing, routing/workflow/session-tree abstractions |
| `phenix-conductor` | Headless Phenix ACP server and authoritative aggregate runtime state |
| `phenix-acp-backend` | Standard ACP client transport/adaptation for downstream agents |
| `phenix-runtime-api` | Typed backend/runtime projection types used inside the headless runtime |
| `phenix-acp-presets` | Deterministic fixture/preset machinery used by integration and product validation |

There is intentionally no Rust UI crate. Frontend state that exists only to emulate an editor does not belong in the harness runtime.

## Design rules

- Prefer one canonical typed API over versioned or compatibility surfaces.
- Parse external data at boundaries and keep invalid runtime states difficult to represent internally.
- Preserve typed failure modes across configuration, transport, protocol, runtime, and UI boundaries.
- Standard ACP remains authoritative for singular-agent behavior; Phenix extensions cover aggregate orchestration concepts.
- Do not add parallel frontend-to-agent protocols or duplicate orchestration implementations.
- Prefer native Neovim behavior over plugin abstractions whenever the problem is fundamentally editing, navigation, windows, buffers, or selection.
- Add richer frontend behavior only when a concrete interaction requires it.
- Tests should assert domain behavior, user-visible semantics, or cross-boundary integration, not declarations or duplicated configuration facts.

## Development

Enter the development shell:

```sh
nix develop
```

Apply deterministic normalization:

```sh
maintenance fix
```

Run the complete validation graph:

```sh
maintenance all
```

The product layer includes a headless Neovim/ACP smoke test that exercises the actual plugin transport, prompt-buffer submission, plain transcript projection, sidebar toggling, process persistence, and shutdown.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for focused validation commands.
