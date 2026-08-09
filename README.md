# Phenix Agent Harness

Phenix is an ACP-native agent harness built around a **headless conductor** and **replaceable frontends**. The current terminal frontend is one client of that conductor; it is not the orchestration runtime itself.

The project is under active architectural development. Prefer the current typed Rust/ACP implementation over compatibility layers or historical design documents. Superseded APIs and duplicated runtime paths should be removed rather than preserved.

## Architecture

```text
                         Phenix

     frontend / client                     orchestration core
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ phenix-tui                   │       │ phenix-conductor             │
│                              │       │                              │
│ terminal UX                  │ ACP   │ Phenix ACP server            │
│ transcript + composer        ├──────►│ configuration revisions      │
│ navigation + overlays        │       │ session trees + objectives   │
│ auth / permission UX         │       │ routing + workflows          │
│ Lua authoring surface        │       │ downstream session bindings  │
└──────────────────────────────┘       └──────────────┬───────────────┘
                                                     │ standard ACP
                                                     ▼
                                      ┌──────────────────────────────┐
                                      │ Pi / Codex / other ACP agent │
                                      └──────────────────────────────┘
```

The important boundary is simple:

> **The conductor owns orchestration. The TUI owns interaction and presentation.**

A frontend may author configuration and request operations, but it must not become a second implementation of routing, workflows, session-tree state, or downstream agent management.

## Conductor

`phenix-conductor` is the headless runtime and canonical application boundary.

It should own:

- immutable configuration revisions;
- Phenix session-tree and node identity;
- objectives and workflow state;
- difficulty-aware routing to complete backend/provider/model/thinking configurations;
- downstream ACP session bindings;
- aggregate lifecycle, cancellation, recovery, and health state;
- typed Phenix extensions for concepts that standard ACP does not represent.

Northbound, the conductor exposes standard ACP plus typed `_phenix/*` extensions. Southbound, it is an ordinary ACP client. A Phenix session tree can therefore aggregate several ordinary ACP sessions without inventing a second agent protocol.

The conductor is **mechanism, not policy**. It provides the machinery to validate and execute user-supplied backends, routing tables, workflows, and tool policy. It should not silently install repository examples, preferred models, roles, or workflows.

Control flow belongs in typed orchestration data and code. Branching, retries, joins, limits, and similar semantics should not be simulated through prompt prose when they become part of the runtime.

## TUI

`phenix-tui` is the native Rust/Ratatui frontend. It is a client of the conductor.

It should own:

- transcript, composer, run-tree, status, picker, dialog, and overlay UX;
- input, focus, scrolling, pane visibility, and terminal lifecycle;
- authentication, permission, model, command, and session interaction surfaces;
- frontend keymaps and semantic theming;
- Lua as an authoring surface for frontend configuration and conductor policy submission.

It should **not** own:

- workflow execution;
- routing decisions;
- authoritative session-tree or objective state;
- downstream ACP process/session management;
- a frontend-specific protocol fallback.

The frontend should compose established Ratatui ecosystem abstractions where they fit rather than rebuilding low-level text, layout, or terminal primitives. Phenix-specific frontend abstractions should be semantic units such as transcript blocks, rich text, images, panes, pickers, and run navigation.

### UX direction

The intended frontend is chat-first and editor-like:

- keep transcript and composer as the primary surface;
- use a stable workspace rather than many unrelated pages;
- progressively disclose orchestration and diagnostics;
- keep the selected run, input target, and actively executing run distinct;
- only expose actions supported by negotiated capabilities;
- preserve drafts, selection, scroll position, and navigation context across temporary UI;
- surface errors in context with an actionable next step;
- use Neovim-shaped navigation over semantic Phenix objects rather than treating Vim keys as an independent UI model.

Exact keybindings and presentation details belong in the effective frontend configuration and runtime help, not in the architectural contract.

## Configuration

A fresh conductor is unconfigured. Frontends or other clients submit configuration through the Phenix ACP control plane.

Applying configuration creates an immutable revision. New session trees use the active revision; existing trees remain pinned to the revision under which they were created. Multiple trees with different immutable configurations may coexist.

Lua is a first-class authoring surface, not a second runtime implementation. Structured Lua definitions and external JSON/TOML/RON/Markdown sources converge through the same canonical parsing and validation boundary before becoming conductor-owned state.

The repository configuration under [`config/phenix-harness/`](config/phenix-harness/) is an explicit example/authoring configuration. It is not implicit conductor policy.

## Crate boundaries

The workspace is intentionally split by responsibility:

| Crate | Responsibility |
| --- | --- |
| `phenix-acp` | Canonical Phenix protocol/domain types, source parsing, routing/workflow/session-tree abstractions |
| `phenix-conductor` | Headless Phenix ACP server and authoritative aggregate runtime state |
| `phenix-acp-backend` | Standard ACP client transport/adaptation for downstream agents |
| `phenix-runtime-api` | Typed frontend/runtime projection boundary |
| `phenix-tui` | Ratatui terminal application and renderer integration |
| `phenix-ui-core` | Renderer-neutral UI state and semantic frontend types |
| `phenix-ui-runtime` | Frontend event/reducer runtime |
| `phenix-ui-lua` | Lua frontend/configuration provider |
| `phenix-frontend-config` | Frontend configuration boundary |

The packaged ACP smoke fixture is test/product-validation machinery, not a reusable application API.

These boundaries should remain strong enough that another frontend can use the same conductor without inheriting Ratatui or Lua implementation details.

## Design rules

- Prefer one canonical typed API over versioned or compatibility surfaces.
- Parse external data at boundaries and keep invalid states difficult to represent internally.
- Preserve typed failure modes across configuration, transport, protocol, runtime, and UI boundaries.
- Standard ACP remains authoritative for singular-agent behavior; Phenix extensions cover aggregate orchestration concepts.
- Do not add parallel frontend-to-agent protocols or duplicate orchestration implementations.
- Tests should assert domain behavior, user-visible semantics, or cross-boundary integration—not source shape, version counters, literal internal layouts, compatibility spellings, or other incidental implementation details.

## Documentation

The documentation set is intentionally small:

- [`docs/frontend-lua.md`](docs/frontend-lua.md) — user-facing Lua frontend/configuration API.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — development environment and canonical validation commands.
- [`AGENTS.md`](AGENTS.md) — repository working rules for coding agents.
- [`config/phenix-harness/README.md`](config/phenix-harness/README.md) — scope of the explicit example configuration.

Implementation details should live next to the code and tests that enforce them. Historical architecture/spec documents should not be retained once the implementation has moved on.

## Development

Enter the development shell:

```sh
nix develop
```

Apply deterministic mechanical fixes:

```sh
maintenance fix
```

Run the complete validation graph:

```sh
maintenance all
```

The flake exposes the generated maintenance provider as `packages.<system>.phenix-maintenance`. The same Nix-declared command tree drives local help/dispatch and CI stage discovery, with explicit source/static, Rust unit, crate/API integration, black-box system, and Nix-installed product/package boundaries.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the exact boundaries and focused commands.
