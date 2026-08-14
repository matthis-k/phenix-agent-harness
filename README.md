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
               │ standard ACP + attached MCP-over-ACP
               ▼
┌──────────────────────────────┐
│ phenix-acp-runtime (default)  │
│ or another conforming agent  │
└──────────────────────────────┘
```

`phenix-conductor` is the authoritative aggregate runtime. Northbound it exposes standard ACP plus typed `_phenix/*` extensions for aggregate concepts that standard ACP does not model. Southbound it is an ordinary ACP client.

The `phenix-conductor` executable includes the Phenix-owned runtime behind the default-enabled `builtin-runtime` Cargo feature. It is launched as `phenix-conductor runtime`, speaks ordinary ACP, and owns provider credentials, provider/model projection, streaming inference, reasoning levels, permissions, and the model tool loop. A single permission-gated `phenix_terminal` tool provides workspace command execution; conductor-owned semantic tools arrive separately through MCP-over-ACP. Building `phenix-conductor --no-default-features` removes that implementation and leaves the generic conductor boundary intact for third-party ACP agents.

A frontend may author configuration and request operations, but routing, workflows, session-tree state, downstream session ownership, lifecycle, and recovery remain conductor concerns.

For coordinator sessions, the conductor derives a fixed model-tool catalog (`phenix_delegate`, `phenix_workflow_list`, and `phenix_workflow_start`) from the immutable configuration revision. The internal `ToolProvision` binds revision, tree, node, and role authority out of band; model arguments never supply authoritative session identity. `phenix-acp-backend` exposes those semantic tools through the official ACP MCP attachment mechanism and rejects an incapable routed agent after `initialize` but before `session/new`. Delegated siblings receive no conductor tool catalog. Agent-specific compatibility remains the responsibility of that agent's ACP adapter.

## Rust boundaries

| Crate | Responsibility |
| --- | --- |
| `phenix-acp` | Canonical Phenix protocol/domain types, source parsing, routing/workflow/session-tree abstractions |
| `phenix-conductor` | Headless Phenix ACP server and authoritative aggregate runtime state |
| `phenix-acp-backend` | Standard ACP client transport/adaptation for downstream agents |
| `phenix-acp-runtime` | Default provider runtime, credential store, streaming agent loop, and MCP-over-ACP tool consumer |
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

The conductor package contains the default runtime; there is no second runtime package to install.

## Built-in runtime authentication

The runtime advertises one ACP terminal-auth method per implemented provider. ACP frontends can launch those flows directly; the equivalent command is:

```sh
phenix-conductor runtime auth login <provider>
```

Credentials are stored atomically in `${XDG_STATE_HOME:-$HOME/.local/state}/phenix/credentials.json`; on Unix, newly created credential directories use mode `0700` and credential files are forced to `0600`. Set `PHENIX_CREDENTIAL_FILE` to select a different credential store. Provider-native environment variables remain supported and are used when no stored credential exists.

`openai-responses` is OpenAI's API-key-authenticated Responses API. `openai-codex` is the distinct ChatGPT subscription path: `auth login openai-codex` prints a browser authorization link, verifies the OAuth callback state and PKCE exchange, persists refresh credentials, and refreshes access tokens before use. Its model requests use the Phenix-owned prompt and tool loop against the ChatGPT Codex Responses endpoint, so no additional agent harness or system prompt is introduced.

Configured model identities use `Phenix/provider/model`. The bundled ChatGPT subscription profile is `router.chatgpt-plus`.

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
