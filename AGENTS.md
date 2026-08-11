# Phenix agent harness instructions

This repository is the native Phenix agent harness. Treat the current Rust/ACP implementation and Neovim frontend as authoritative; do not restore deleted Ratatui UI crates, Pi-extension, TypeScript, JSONL-process, or compatibility paths.

## Source of truth

Use this order:

1. Executable Rust/Lua code and deterministic tests.
2. [`README.md`](README.md) for the intended architecture and subsystem boundaries.
3. `config/phenix-harness/` for the explicit example authoring configuration.
4. Focused current references such as `docs/frontend-lua.md`.
5. This file for repository working rules.

When documentation and code disagree, fix or remove the stale documentation in the same change.

## Architecture discipline

The root README defines the intended split: **the conductor owns orchestration; Neovim owns editor behavior; `phenix-nvim` owns only semantic interaction with the conductor.**

Keep that boundary explicit:

- `phenix-conductor` is the authoritative aggregate runtime and Phenix ACP server.
- `phenix-nvim` is an ACP client; it must not grow a second routing, workflow, session-tree, or downstream-process implementation.
- `phenix-acp-backend` adapts ordinary ACP agents through the official Rust SDK.
- Lua is an authoring/configuration surface and frontend integration language, not a second orchestration runtime.
- A running session tree has immutable configuration; multiple independently configured trees may coexist.
- Standard ACP owns singular-agent behavior; typed `_phenix/*` extensions cover aggregate orchestration concepts ACP does not model.
- Use nominal/typed identifiers and parse external data once at Rust boundaries. Do not propagate unchecked stringly state through the headless runtime.

There is one supported frontend-to-agent path: Neovim speaks ACP to `phenix-conductor`. Do not add a second process protocol, backend selector, headless compatibility fallback, or duplicate orchestration implementation.

## Frontend discipline

Use Neovim as the editor instead of emulating one.

- Prefer native buffers, windows, tabs, folds, motions, search, selection, registers, marks, syntax, highlighting, and keymaps.
- Do not implement a custom input editor, Vim mode machine, text-cell renderer, pane tree, scrolling model, selection model, or fold engine.
- Keep the transcript and composer as normal Neovim buffers whenever possible so user configuration and plugins continue to apply naturally.
- Use `nui.nvim` for semantic transient UI such as pickers, menus, dialogs, and bounded composed surfaces where native primitives alone would be unnecessarily low-level.
- NUI is an implementation aid, not an application framework boundary. Keep UI state small and derive presentation from ACP/session state.
- Do not impose replacement mappings for ordinary Neovim navigation. Phenix-specific mappings should invoke semantic agent actions only.
- Keep backend routing/workflow policy out of the plugin presentation layer.
- Prefer ACP standard methods/callbacks when the interaction is already represented by ACP; use Phenix extensions only for aggregate concepts ACP does not model.

## Change discipline

- Remove superseded APIs and compatibility paths instead of maintaining parallel versions.
- Prefer an existing platform/library abstraction when it expresses the required semantics.
- Keep semantic names even when using a library type internally.
- Make invalid runtime states difficult or impossible to represent.
- Preserve typed errors at subsystem boundaries; do not collapse actionable failures into generic exit states.
- Add focused regression tests for behavioral fixes and integration tests for cross-boundary behavior.
- Keep implementation-specific invariants close to the code/tests that enforce them instead of creating speculative design documents.

## Testing discipline

Tests validate behavior, not declarations.

- Ordinary Nix configuration is allowed to be misconfigured; the build/run that consumes it is the meaningful validation boundary.
- Do not mirror Nix options, package selections, file declarations, or literal configuration values into tests merely to assert that the source says the same thing twice.
- Direct Nix tests are appropriate when the Nix expression itself is nontrivial reusable program logic: composition libraries, transformations, generated aggregates, ordering/precedence rules, or similar machinery.
- Product checks should build, start, execute, or otherwise exercise realized outputs.
- The Neovim frontend test should speak ACP to a deterministic fixture through a real headless Neovim process rather than inspecting plugin source shape.
- Keep a behavior in one canonical execution layer; product derivations must not rerun the Cargo behavioral suites.

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

Validation is separated by boundary:

- `maintenance check source`: formatting, Nix static analysis, workflow syntax/synchronization, and Cargo test-target classification;
- `maintenance check rust`: Clippy/static Rust gate;
- `maintenance test unit`: in-crate tests;
- `maintenance test doc`: Rust documentation tests;
- `maintenance test integration`: crate/API integration targets;
- `maintenance test system`: black-box conductor/process/protocol tests;
- `maintenance test product`: realized Neovim/ACP and package behavior.

CI granularity is declarative. A CI-enabled maintenance command is a visible step; commands with the same `ci.stage` share a GitHub job, while distinct stages become distinct jobs. Prefer leaf commands when individual failure attribution is useful. Aggregate commands remain appropriate when the underlying distinction has no operational value.

Every Cargo integration-test target must be explicitly classified under integration or system maintenance commands. Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix build failures are never auto-repaired.

## Required verification

Before considering a change complete, run the relevant focused layer while iterating and `maintenance all` before final handoff. Do not weaken a check to make transitional code pass; either fix the current implementation or remove the obsolete surface that the check was protecting.
