# Development

The flake is the single owner of the development toolchain, maintenance provider, Nix package checks, and shipped products. There is no separate devenv environment or lockfile.

Repository maintenance is declared once in Nix through `phenix-flake-ci` and materialized as the namespaced flake provider `packages.<system>.phenix-maintenance`. The generated executable is `maintenance`; local development, git hooks, and CI invoke the same command implementations.

## Development shell

```sh
nix develop
```

The shell contains the Rust, Nix, Lua, actionlint, Statix, Stitch, and generated maintenance tooling needed by the repository.

## Canonical commands

Apply deterministic mechanical fixes:

```sh
maintenance fix
```

Run the complete read-only validation graph:

```sh
maintenance all
```

Run one boundary or focused layer directly:

| Command | Boundary |
| --- | --- |
| `maintenance check source` | Source formatting, Nix static analysis, workflow syntax, target classification, and flake evaluation |
| `maintenance check rust` | Rust static analysis with Clippy; this is the compile/type-check gate |
| `maintenance test unit` | In-crate library/binary unit tests |
| `maintenance test doc` | Rust documentation tests |
| `maintenance test integration` | Cargo integration-test targets that exercise crate/API boundaries |
| `maintenance test system` | Black-box Phenix process/protocol tests across shipped Rust binaries and fake ACP agents |
| `maintenance test product` | Nix-built installed-product/package smoke checks |

Aggregate nodes run their children in declared order. Leaf commands can also be selected directly, for example `maintenance test integration phenix-acp-repeated-prompts` or `maintenance test product phenix`.

## Test ownership

Each behavior should have one canonical test layer.

### Unit and documentation

Unit tests live with the crate/module they exercise and should avoid process or package boundaries. They are executed by `maintenance test unit`. Rust documentation tests are a separate `maintenance test doc` leaf so CI can attribute their failures independently.

### Integration

Ordinary Cargo targets under `crates/*/tests/` are integration tests when they exercise a crate through its public API or join several internal components. Each target is represented by a maintenance leaf beneath `maintenance test integration`, so it can be run and reported independently.

The conductor's `black_box_model_tool_loop` and `stdio_roundtrip` targets are intentionally classified under the system layer because they spawn the conductor and fixture/mock agents as processes.

`maintenance check source test-targets` compares Cargo metadata with the explicit integration/system target declarations. Adding a new Cargo integration target therefore requires classifying it rather than silently folding it into an opaque test command.

### System

`maintenance test system` owns conductor subprocess/protocol tests. This is the end-to-end Rust application boundary: real Phenix binaries, deterministic fake ACP backends, no external credentials. Each system target is also a selectable leaf.

### Product

`maintenance test product` owns the Nix/install boundary. Its leaves separately validate the packaged Phenix product, Stitch runtime, and Stitch MCP package.

Product derivations must not rerun the Rust unit/integration/system suites. Cargo owns Rust behavioral tests; Nix owns reproducible packaging and installed composition.

## CI provider

The Nix maintenance declaration controls both **what runs** and **how granularly it is presented** in CI. The reusable command/rendering machinery comes from the `phenix-flake-ci` input; the harness keeps its own source, Rust, integration, system, and product policy in `modules/development.nix`.

A command opts into CI with `ci.enable`. An enabled command is one visible CI step. `ci.stage` assigns that step to a job; commands with the same stage share a job, while different stages become different jobs. Job-level metadata such as runner, timeout, dependencies, and shared environment is declared alongside that stage metadata.

This makes granularity a repository choice rather than a framework constant:

- enable an aggregate node to expose one coarse CI unit;
- enable its children to expose separate steps;
- represent individual test targets as leaf commands to report them individually;
- give leaves separate stages when they need isolated/parallel jobs;
- keep related leaves in one stage when shared state is useful.

The harness currently keeps Rust leaves in one `Rust` job so they share `CARGO_HOME` and `CARGO_TARGET_DIR`, while Clippy, unit tests, doc tests, every declared Cargo integration/system target, and product checks appear as distinct GitHub steps.

GitHub Actions must know its step topology before runtime execution, so `phenix-flake-ci` renders `.github/workflows/ci.yml` from the Nix declaration. The committed YAML is a generated projection, not a second command graph. `maintenance check source workflow-sync` evaluates the generated workflow and fails if the committed file differs.

The final `Maintenance checks` job remains the aggregate required status.

## Pre-commit

The maintenance declaration enables the shared `phenix-flake-ci` pre-commit integration with `gitHooks.preCommit = [ "fix" ]`. Entering `nix develop` installs that generated hook into the repository's Git directory and configures the repository-local `core.hooksPath`; the harness does not carry a second `.githooks` implementation.

The hook records the paths staged before `maintenance fix`, applies deterministic normalization, re-stages only those original paths, and runs `git diff --cached --check`. Outside the development shell it falls back to:

```sh
nix develop --command maintenance fix
```

Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix evaluation/build failures are never auto-repaired.

## Stitch

Inspect the repository workspace graph with:

```sh
stitch workspace discover --json
```
