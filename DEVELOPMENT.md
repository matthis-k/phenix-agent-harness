# Development

The flake is the single owner of the development toolchain, maintenance provider, Nix package checks, and shipped ACP products. There is no separate devenv environment or lockfile.

Repository maintenance is declared once in Nix through `phenix-flake-ci` and materialized as `packages.<system>.phenix-maintenance`. The generated executable is `maintenance`; local development, git hooks, and CI invoke the same command implementations.

## Development shell

```sh
nix develop
```

The shell contains Rust, Nix, actionlint, Statix, Stitch, and generated maintenance tooling.

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
| `maintenance check source` | Source formatting, Nix static analysis, workflow syntax/synchronization, and Cargo test-target classification |
| `maintenance check rust` | Rust static analysis with Clippy; this is the compile/type-check gate |
| `maintenance test unit` | In-crate library/binary unit tests |
| `maintenance test doc` | Rust documentation tests |
| `maintenance test integration` | Cargo integration-test targets that exercise crate/API boundaries |
| `maintenance test system` | Black-box conductor/process/protocol tests across real Rust binaries and deterministic ACP fixtures |
| `maintenance test product` | Realized ACP and packaged-product behavior |

Aggregate nodes run their children in declared order. Leaf commands can also be selected directly, for example `maintenance test integration phenix-acp-repeated-prompts` or `maintenance test product phenix-acp`.

## Test ownership

Each behavior has one canonical test layer.

### Unit and documentation

Unit tests live with the Rust crate/module they exercise and avoid process or package boundaries. They are executed by `maintenance test unit`. Rust documentation tests are a separate `maintenance test doc` leaf so CI can attribute their failures independently.

### Integration

Ordinary Cargo targets under `crates/*/tests/` are integration tests when they exercise a crate through its public API or join several internal components. Each target is represented by a maintenance leaf beneath `maintenance test integration`.

The conductor's `black_box_model_tool_loop` and `stdio_roundtrip` targets are intentionally classified under the system layer because they spawn the conductor and fixture/mock agents as processes.

`maintenance check source test-targets` compares Cargo metadata with the explicit integration/system target declarations. Adding a new Cargo integration target therefore requires classifying it rather than silently folding it into an opaque test command.

### System

`maintenance test system` owns conductor subprocess/protocol tests. This is the end-to-end Rust application boundary: real Phenix binaries, deterministic fake ACP backends, no external credentials.

### Product

`maintenance test product` owns realized ACP/package behavior. The `phenix-acp` leaf runs the installed ACP smoke fixture. Stitch runtime/package validation remains separate.

Frontend product behavior belongs to the frontend repository, currently `matthis-k/phenix-nvim` for Neovim.

Product derivations do not rerun the Rust unit/integration/system suites. Cargo owns Rust behavioral tests; the product layer owns behavior that exists only after application composition/packaging.

## Nix testing rule

Ordinary Nix configuration is not duplicated into assertions.

If a package, wrapper, application, or system is misconfigured, the build/run that consumes that configuration is the useful failure boundary. Do not add checks that restate selected options, package names, file declarations, or literal values merely to prove the declaration was written.

Direct tests of Nix expressions are reserved for Nix that is itself nontrivial reusable program logic: composition libraries, transformations, ordering/precedence rules, generated aggregates, and similar machinery.

For the same reason this repository does not carry a generic `nix flake check --no-build` source gate. Every maintenance command already requires the flake/maintenance declaration to evaluate, and product commands realize the outputs whose configuration matters.

## CI provider

The Nix maintenance declaration controls both what runs and how granularly it is presented in CI. Reusable command/rendering machinery comes from the `phenix-flake-ci` input; `phenix-acp` keeps its source, Rust, integration, system, and product policy in `modules/development.nix`.

A command opts into CI with `ci.enable`. An enabled command is one visible CI step. `ci.stage` assigns that step to a job; commands with the same stage share a job, while different stages become different jobs.

Rust leaves remain in one `Rust` job so they share `CARGO_HOME` and `CARGO_TARGET_DIR`, while Clippy, unit tests, doc tests, every declared Cargo integration/system target, and product checks remain separately attributable steps.

GitHub Actions must know its topology before runtime execution, so `phenix-flake-ci` renders `.github/workflows/ci.yml` from the Nix declaration. The committed YAML is a generated projection, not a second command graph. `maintenance check source workflow-sync` evaluates the generated workflow and fails if the committed file differs.

The final `Maintenance checks` job remains the aggregate required status.

## Pre-commit

The maintenance declaration enables the shared `phenix-flake-ci` pre-commit integration with `gitHooks.preCommit = [ "fix" ]`. Entering `nix develop` installs that generated hook into the repository's Git directory.

The hook records the paths staged before `maintenance fix`, applies deterministic normalization, re-stages only those original paths, and runs `git diff --cached --check`. Outside the development shell it falls back to:

```sh
nix develop --command maintenance fix
```

Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix build failures are never auto-repaired.

## Stitch

Inspect the repository workspace graph with:

```sh
stitch workspace discover --json
```
