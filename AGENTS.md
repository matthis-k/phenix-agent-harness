# Phenix agent harness instructions

This repository is the native Phenix agent harness. Treat the current Rust/ACP implementation as authoritative; do not restore deleted Pi-extension, TypeScript, JSONL-process, or compatibility paths.

## Source of truth

Use this order:

1. Executable Rust code and deterministic tests.
2. [`README.md`](README.md) for the intended architecture and subsystem boundaries.
3. `config/phenix-harness/` for the explicit example authoring configuration.
4. Focused current references such as `docs/frontend-lua.md`.
5. This file for repository working rules.

When documentation and code disagree, fix or remove the stale documentation in the same change.

## Architecture discipline

The root README defines the intended split: **the conductor owns orchestration; the TUI owns interaction and presentation**.

Keep that boundary explicit:

- `phenix-conductor` is the authoritative aggregate runtime and Phenix ACP server.
- `phenix-tui` is a conductor client; it must not grow a second routing, workflow, session-tree, or downstream-process implementation.
- `phenix-acp-backend` adapts ordinary ACP agents through the official Rust SDK.
- Lua is an authoring/configuration surface, not a second runtime implementation.
- A running session tree has immutable configuration; multiple independently configured trees may coexist.
- Standard ACP owns singular-agent behavior; typed `_phenix/*` extensions cover aggregate orchestration concepts ACP does not model.
- Use nominal/typed identifiers and parse external data once at boundaries. Do not propagate unchecked stringly state through the runtime.

There is one supported frontend-to-agent path. Do not add a second process protocol, backend selector, headless compatibility fallback, or duplicate orchestration implementation.

## Frontend discipline

- Prefer Ratatui ecosystem widgets and abstractions over local low-level primitives.
- The frontend should compose UX and typed integrations rather than reimplement text/layout/rendering fundamentals.
- Rich text, transcript blocks, images, panes, pickers, and other semantic UI units are valid frontend abstractions; raw text-cell or layout machinery should normally come from libraries.
- Keep backend routing/workflow policy out of the renderer and input layer.
- Put exact keybindings and presentation behavior in effective configuration/runtime help rather than duplicating them in architecture prose.

## Change discipline

- Remove superseded APIs and compatibility paths instead of maintaining parallel versions.
- Prefer an existing library/platform abstraction when it expresses the required semantics.
- Keep semantic names even when using a library type internally.
- Make invalid runtime states difficult or impossible to represent.
- Preserve typed errors at subsystem boundaries; do not collapse actionable failures into generic exit states.
- Add focused regression tests for behavioral fixes and integration tests for cross-boundary behavior.
- Keep implementation-specific invariants close to the code/tests that enforce them instead of creating speculative design documents.

## Maintenance

Mechanical, semantics-preserving normalization is repository-owned:

```sh
devenv tasks run maintenance:fix
```

It applies canonical Rust/Nix formatting and safe Statix rewrites. Pull-request CI applies the same mechanical fixes automatically to same-repository branches and commits them before validation.

Validation remains read-only and explicit by concern:

```sh
devenv test
```

The maintenance graph checks formatting, Rust compilation, Clippy, Rust tests, Nix static analysis, GitHub Actions syntax, required tools, and the flake/smoke checks.

Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix evaluation/build failures are never auto-repaired.

## Required verification

Before considering a change complete, the repository must pass the canonical maintenance graph and leave the committed tree clean. Do not weaken a check to make transitional code pass; either fix the current implementation or remove the obsolete surface that the check was protecting.
