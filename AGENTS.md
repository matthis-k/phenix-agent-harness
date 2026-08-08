# Phenix agent harness instructions

This repository is the native Phenix agent harness. Treat the current Rust/ACP implementation as authoritative; do not restore deleted Pi-extension, TypeScript, JSONL-process, or compatibility paths.

## Source of truth

Use this order:

1. Executable Rust code and deterministic tests.
2. `config/phenix-harness/` for the packaged authoring configuration.
3. `docs/phenix-acp.md` and focused current design documents.
4. This file for repository working rules.

When documentation and code disagree, fix or remove the stale documentation in the same change.

## Current architecture

```text
Ratatui frontend (`phenix-tui`)
        |
        v
frontend config / typed UI state
        |
        v
Phenix conductor + ACP gateway
        |
        v
standard ACP backends (`phenix-acp-backend`)
        |
        v
Pi ACP / other ACP-compatible agents
```

- `phenix-tui` owns terminal UX, rendering, input, focus, overlays, and frontend integration.
- `phenix-ui-core`, `phenix-ui-runtime`, `phenix-ui-lua`, and `phenix-frontend-config` own frontend state/configuration boundaries.
- `phenix-acp` owns typed Phenix session-tree, routing, workflow, configuration, and extension protocol concepts.
- `phenix-conductor` owns aggregate orchestration and the standard/Phenix ACP boundary.
- `phenix-acp-backend` adapts standard ACP agents through the official Rust SDK.
- `phenix-runtime-api` is the typed runtime boundary shared by backend and frontend layers.
- Pi is an external ACP backend dependency. Phenix does not patch or embed a second Pi-facing application layer.

There is one supported frontend-to-agent path. Do not add a second process protocol, backend selector, headless TypeScript fallback, or duplicate orchestration implementation.

## Configuration

- A running session tree has immutable configuration.
- Multiple independently configured trees may coexist.
- Lua is an authoring/configuration surface, not a second runtime implementation.
- Standard ACP owns singular-agent behavior; `_phenix/*` extensions cover Phenix orchestration concepts that ACP does not model.
- Use nominal/typed identifiers and parse external data once at boundaries. Do not propagate unchecked stringly state through the runtime.

## Frontend discipline

- Prefer Ratatui ecosystem widgets and abstractions over local low-level primitives.
- The frontend should compose UX and typed integrations rather than reimplement text/layout/rendering fundamentals.
- Rich text, transcript blocks, images, panes, and other semantic UI units are valid frontend abstractions; raw text-cell or layout machinery should normally come from libraries.
- Keep backend routing/workflow policy out of the renderer and input layer.

## Change discipline

- Remove superseded APIs and compatibility paths instead of maintaining parallel versions.
- Prefer an existing library/platform abstraction when it expresses the required semantics.
- Keep semantic names even when using a library type internally.
- Make invalid runtime states difficult or impossible to represent.
- Preserve typed errors at subsystem boundaries; do not collapse actionable failures into generic exit states.
- Add focused regression tests for behavioral fixes and integration tests for cross-boundary behavior.

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
