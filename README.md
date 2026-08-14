# Phenix ACP

`phenix-acp` is the headless ACP protocol, conductor, and backend-orchestration repository for Phenix.

The Neovim frontend lives separately in `matthis-k/phenix-nvim`. This repository does not own editor windows, input handling, transcript presentation, Neovim plugin packaging, or frontend-specific tests.

The project is under active architectural development. Prefer the current typed Rust/ACP implementation over compatibility layers or historical APIs.

## Architecture

```text
phenix-nvim / other ACP client
            │
            │ standard ACP + typed _phenix/* extensions
            ▼
┌──────────────────────────────┐
│ phenix-conductor             │
│                              │
│ configuration revisions      │
│ session trees + objectives   │
│ routing + workflows          │
│ aggregate lifecycle          │
└──────────────┬───────────────┘
               │ standard ACP
               ▼
┌──────────────────────────────┐
│ Pi / Codex / other ACP agent │
└──────────────────────────────┘
```

`phenix-conductor` is the authoritative aggregate runtime. Northbound it exposes standard ACP plus typed `_phenix/*` extensions for aggregate concepts that standard ACP does not model. Southbound it is an ordinary ACP client.

A frontend may author configuration and request operations, but routing, workflows, session-tree state, downstream session ownership, lifecycle, and recovery remain conductor concerns.

## Rust boundaries

| Crate | Responsibility |
| --- | --- |
| `phenix-acp` | Canonical Phenix protocol/domain types, source parsing, routing/workflow/session-tree abstractions |
| `phenix-conductor` | Headless Phenix ACP server and authoritative aggregate runtime state |
| `phenix-acp-backend` | Standard ACP client transport/adaptation for downstream agents |
| `phenix-runtime-api` | Typed backend/runtime projection types used inside the headless runtime |
| `phenix-acp-presets` | Deterministic fixture/preset machinery used by integration and product validation |

There is intentionally no UI crate or Neovim plugin in this repository.

## Configuration

A fresh conductor is unconfigured. A client selects a source root and descriptors, then calls `_phenix/config/load`; the conductor resolves relative paths beneath that root, validates every source, and atomically creates an immutable revision. New session trees use the active revision; existing trees remain pinned to the revision under which they were created. The conductor does not implicitly discover XDG configuration or repository examples.

For the standard ACP projection, initialization order is explicit: `initialize`, then `_phenix/config/load`, then `session/new`. `session/new` cannot create a standard Phenix session before an active configuration revision exists. Frontends are responsible for supplying their selected configuration before requesting the session. After loading, `_phenix/config/get` returns the active revision and its callable workflow catalog; integrations must use that conductor-owned catalog rather than re-derive workflows from their authoring input.

The example authoring configuration under `config/phenix-harness/` is retained as an explicit application configuration. Its name is not the repository name.

The conductor is mechanism, not policy. It validates and executes supplied backends, routing tables, workflows, and tool policy; it does not silently install preferred models, roles, or workflows.

## Packages

The flake exposes the headless ACP products directly:

- `packages.<system>.phenix-conductor`;
- `packages.<system>.phenix-acp-smoke`;
- `packages.<system>.default` = `phenix-conductor`.

The Neovim plugin and configured Neovim wrapper are exported by `phenix-nvim` instead.

## Design rules

- Prefer one canonical typed API over versioned or compatibility surfaces.
- Parse external data at boundaries and keep invalid runtime states difficult to represent internally.
- Preserve typed failure modes across configuration, transport, protocol, and runtime boundaries.
- Standard ACP remains authoritative for singular-agent behavior; Phenix extensions cover aggregate orchestration concepts.
- Do not add parallel frontend-to-agent protocols or duplicate orchestration implementations.
- Keep frontend-specific behavior and packaging in frontend repositories.
- Tests should assert domain behavior, user-visible protocol semantics, or cross-boundary integration, not duplicated configuration facts.

## Development

```sh
nix develop
maintenance fix
maintenance all
```

Validation is separated into source, Rust, integration/system, and realized ACP product boundaries. The product layer exercises the installed ACP/conductor artifacts; frontend behavior is tested in `phenix-nvim`.

See `DEVELOPMENT.md` for focused validation commands.
