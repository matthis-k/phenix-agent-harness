# Phenix Agent Harness

Phenix is an ACP-native agent harness built around a **headless conductor** and a **Neovim frontend**.

The conductor owns orchestration. Neovim owns interaction. The frontend deliberately uses editor-native buffers, windows, editing, navigation, folds, syntax, and keymaps instead of recreating an editor inside a terminal UI.

The project is under active architectural development. Prefer the current typed Rust/ACP implementation over compatibility layers or historical design documents. Superseded APIs and duplicated runtime paths should be removed rather than preserved.

## Architecture

```text
                         Phenix

       Neovim frontend                         orchestration core
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ phenix-nvim                  │       │ phenix-conductor             │
│                              │       │                              │
│ native buffers + windows     │ ACP   │ Phenix ACP server            │
│ transcript + composer        ├──────►│ configuration revisions      │
│ native motions + folds       │       │ session trees + objectives   │
│ NUI transient surfaces       │       │ routing + workflows          │
│ session interaction          │       │ downstream session bindings  │
└──────────────────────────────┘       └──────────────┬───────────────┘
                                                     │ standard ACP
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │ Pi / Codex / other ACP agent │
                                      └──────────────────────────────┘
```

The boundary is intentionally narrow:

> **The conductor owns orchestration. Neovim owns editor behavior. `phenix-nvim` only bridges semantic agent interaction into those native editor primitives.**

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

`phenix-nvim` is the interactive frontend under [`nvim/`](nvim/). It talks to `phenix-conductor` directly over ACP stdio.

The frontend uses Neovim itself for concerns that are already editor behavior:

- the transcript is a normal Markdown scratch buffer;
- the composer is a normal editable buffer in a split;
- ordinary motions and scrolling work without a Phenix navigation layer;
- thinking and tool sections use native folds, so normal fold commands such as `zo` and `zc` apply;
- syntax, selection, copy, search, marks, registers, macros, window commands, and user keymaps remain Neovim features;
- status is projected into editor window metadata rather than a custom terminal renderer.

[`nui.nvim`](https://github.com/MunifTanjim/nui.nvim) is used for transient composition such as selectors and dialogs. It is not a replacement editor or a second layout/runtime model.

The plugin must not reimplement:

- text editing or cursor movement;
- Vim/Neovim modes and motions;
- terminal-cell rendering;
- syntax/highlight parsing that Neovim already owns;
- a parallel pane/layout engine;
- workflow execution, routing decisions, or authoritative session state.

### Commands

The plugin currently exposes:

```vim
:PhenixOpen [cwd]
:PhenixNew [cwd]
:PhenixPrompt [text]
:PhenixConfig
:PhenixCancel
:PhenixClose
```

`require("phenix").setup({...})` may override the conductor command, working directory behavior, or configuration file for embedding in an existing Neovim setup.

The packaged `phenix` executable is a convenience launcher for Neovim with `phenix-nvim`, `nui.nvim`, the packaged conductor, and the packaged example configuration on the runtime path/closure. The plugin can also be consumed directly from an existing Neovim configuration.

The plugin package is exported both as `packages.<system>.phenix-nvim` and through the traditional Nixpkgs plugin namespace as `legacyPackages.<system>.vimPlugins.phenix-nvim`. Consumers that apply this flake's default overlay can use `pkgs.vimPlugins.phenix-nvim` directly.

## Configuration

A fresh conductor is unconfigured. The frontend submits authored configuration through `_phenix/config/apply` before creating the standard interactive ACP session.

The repository configuration under [`config/phenix-harness/`](config/phenix-harness/) remains the explicit example/authoring configuration. Its `phenix.acp.*` Lua calls are evaluated by the Neovim plugin and converted into the same typed conductor configuration input. Lua is therefore an authoring surface, not a second orchestration runtime.

Applying configuration creates an immutable revision. New session trees use the active revision; existing trees remain pinned to the revision under which they were created.

See [`docs/frontend-lua.md`](docs/frontend-lua.md) for the authoring and plugin API.

## Rust boundaries

The Rust workspace now contains only headless protocol/orchestration machinery:

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
- Prefer native Neovim behavior over plugin abstractions whenever the problem is fundamentally editing, navigation, windows, buffers, folds, syntax, or selection.
- Use NUI for semantic transient UI where Neovim does not already provide the desired interaction surface.
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

The product layer includes a headless Neovim/ACP smoke test that exercises the actual plugin transport, configuration authoring, session creation, config-option mutation, prompt streaming, transcript projection, and shutdown.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for focused validation commands.
