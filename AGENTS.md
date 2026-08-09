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

The flake owns the development shell, product packages, package smoke checks, and a single declarative maintenance provider. Do not add a second development-environment lock or task graph.

The provider is exposed as `packages.<system>.phenix-maintenance`; its generated executable is `maintenance`. The Nix command tree is authoritative for command behavior and CI topology. The committed GitHub workflow is generated from that declaration and must stay synchronized with it.

Enter the repository environment with:

```sh
nix develop
```

Apply deterministic normalization with:

```sh
maintenance fix
```

Run the complete read-only validation graph with:

```sh
maintenance all
```

Validation is intentionally separated by boundary:

- `maintenance check source`: formatting, Nix static analysis, workflow syntax/synchronization, target classification, and flake evaluation;
- `maintenance check rust`: Clippy/static Rust gate;
- `maintenance test unit`: in-crate tests;
- `maintenance test doc`: Rust documentation tests;
- `maintenance test integration`: crate/API integration targets;
- `maintenance test system`: black-box Phenix process/protocol tests;
- `maintenance test product`: Nix-built installed-product/package smoke tests.

CI granularity is declarative. A CI-enabled maintenance command is a visible step; commands with the same `ci.stage` share a GitHub job, while distinct stages become distinct jobs. Prefer leaf commands when individual failure attribution is useful. Aggregate commands remain appropriate when the underlying distinction has no operational value.

Every Cargo integration-test target must be explicitly classified under integration or system maintenance commands. Keep a behavior in one canonical execution layer; product derivations must not rerun the Cargo behavioral suites.

Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix evaluation/build failures are never auto-repaired.

## Required verification

Before considering a change complete, run the relevant focused layer while iterating and `maintenance all` before final handoff. Do not weaken a check to make transitional code pass; either fix the current implementation or remove the obsolete surface that the check was protecting.
