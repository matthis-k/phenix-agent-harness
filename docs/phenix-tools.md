# Phenix tools — Pi extension

## Tool surface

Core read-only:

| Tool | Description |
|------|-------------|
| `read` | Read files, directories, JSON, text with bounds and line numbers |
| `search` | Content search via `ripgrep` with structured results |
| `find` | Path lookup via `fd` (or Node fallback) with ranked results |
| `ast_grep` | Structural code query via `ast-grep` AST patterns |
| `lsp` | IDE-grade code intelligence (diagnostics, hover, definition, references, symbols) |

Mutation flow (preview → resolve):

| Tool | Description |
|------|-------------|
| `edit` | Safe text edits with stale/anchor protection and preview |
| `ast_edit` | Structural AST rewrites with preview |
| `resolve` | Central gate to apply or discard pending actions |

Workflow state:

| Tool | Description |
|------|-------------|
| `todo` | Structured checklist with phase tracking |
| `task` | Durable task/subtask records with status |
| `job` | Background process management |

## Design

This tool set is inspired by [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT
licensed). The Phenix version is a **smaller, safer, Nix-friendly subset**:

- No SOPS, auth, credential handling
- No browser, SSH, image generation, TTS, web search
- Preview-first mutation (edit/ast_edit → resolve)
- Workspace safety (path boundaries enforced)
- Bounded output (50KB limits)
- State in session entries (survives restarts)

## Dependencies

Runtime tools provided by the wrapper `extraPackages`:

- `ripgrep` (rg) — content search
- `fd` — file path lookup
- `ast-grep` — structural code queries and rewrites
- `nil` — Nix LSP server
- `typescript-language-server` — TypeScript/JavaScript LSP server
- `nodejs` — runtime

## Pi package integration

### `pi-context-tools` (0.1.1, MIT)

**Status: Default-enabled** as a dependency in `package.json`.

Provides `context_info` and `compact_context` tools. Source review:
- Tiny extension (~7.5KB unpacked)
- No external dependencies
- Registers two tools only, no side effects
- No file system writes, no process spawning
- MIT license — clean

Use policy:
- Parent flow may call `context_info` before D2/D3 planning
- Parent flow may call `compact_context` after scout/verifier if context
  is near threshold
- Subagents should not call compaction unless explicitly allowed

### `pi-mcp-adapter` (2.11.0, MIT)

**Status: Opt-in** — not enabled by default.

Larger (~1.9MB unpacked, 8 dependencies). Useful for reducing MCP tool-
definition bloat in subagent contexts. Add via explicit wrapper/profile.

Acceptance criteria for future integration:
- MCP servers accessed through compact adapter interface
- Raw MCP schemas not injected into every child context
- Adapter reads standard MCP config without polluting repo
- Direct MCP tools not automatically given to all subagents

Pending source review for full integration.

### `context-mode` (1.0.x, Elastic-2.0)

**Status: Experimental-only, NOT integrated.**

Larger (~4.2MB unpacked, 8 dependencies including better-sqlite3).
**Elastic-2.0 licensed** — do not vendor any code into Phenix.

Phenix does not ship, bundle, or enable `context-mode` by default. It is
available as a user-installable opt-in for users who understand its
behavior (process spawning, FTS5 knowledge base writes, sandboxed code
execution).

If added via custom wrapper/profile, document:
- License/surface
- No code vendored into Phenix
- No repo pollution
- No unexpected daemon/process spawning
- No uncontrolled hook installation
- Can be enabled/disabled via explicit wrapper/profile
- Does not conflict with Pi compaction or `pi-context-tools`

Recommended: "external opt-in, not integrated by default".

## Safety

| Area | Policy |
|------|--------|
| Read-only tools | `read`, `search`, `find`, `ast_grep`, `lsp` — never mutate |
| Edit tools | Preview by default; direct apply disabled by default |
| Resolve | Only tool that applies previewed edits |
| Tasks | No autonomous mutation by default; subagents bounded |
| Jobs | Command+args only; no shell string by default; output bounded |
| Paths | Outside-workspace paths rejected; /nix/store allowed |
| Secrets | No SOPS, auth.json, or credential handling |
| Git | No commit, push, or publish operations |

## License

This tool design is inspired by [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
oh-my-pi is MIT licensed. No substantial source code is copied unless noted in
file headers.

Portions derived from can1357/oh-my-pi, MIT License.
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
