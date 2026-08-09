# Development

The flake is the single owner of the development toolchain, maintenance provider, Nix package checks, and shipped products. There is no separate devenv environment or lockfile.

Repository maintenance is declared once in Nix through Phenix Flake Maintenance and materialized as the namespaced flake provider `packages.<system>.phenix-maintenance`. The generated executable is `maintenance`; CI discovers its stages from the package's `phenixMaintenance.ci` metadata rather than duplicating the command graph in workflow YAML.

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
| `maintenance check source` | Source formatting, Nix static analysis, workflow syntax, and flake evaluation |
| `maintenance check rust` | Rust static analysis with Clippy; this is the compile/type-check gate |
| `maintenance test unit` | In-crate library/binary unit tests and Rust doc tests |
| `maintenance test integration` | Cargo integration-test targets that exercise crate/API boundaries without being full product subprocess tests |
| `maintenance test system` | Black-box Phenix process/protocol tests across shipped Rust binaries and fake ACP agents |
| `maintenance test product` | Nix-built installed-product/package smoke checks |

`maintenance check` runs the source and Rust static layers. `maintenance test` runs all behavioral/product layers. `maintenance all` runs both aggregates in order.

## Test ownership

Each behavior should have one canonical test layer.

### Unit

Unit tests live with the crate/module they exercise and should avoid process or package boundaries. They are executed by `maintenance test unit`.

### Integration

Ordinary Cargo targets under `crates/*/tests/` are integration tests when they exercise a crate through its public API or join several internal components. They are executed by `maintenance test integration`.

The conductor's `black_box_model_tool_loop` and `stdio_roundtrip` targets are intentionally excluded from that layer because they spawn the conductor and fixture/mock agents as processes.

### System

`maintenance test system` owns those conductor subprocess/protocol tests. This is the end-to-end Rust application boundary: real Phenix binaries, deterministic fake ACP backends, no external credentials.

### Product

`maintenance test product` owns the Nix/install boundary. It builds and executes the flake checks that validate the packaged Phenix wrapper, configured/unconfigured startup behavior, ACP smoke binary, and Stitch packaging/runtime smoke tests.

Product derivations must not rerun the Rust unit/integration/system suites. Cargo owns Rust behavioral tests; Nix owns reproducible packaging and installed composition.

## CI provider

Commands opt into CI in the Nix declaration with `ci = true` or structured CI metadata. The generated provider exposes a JSON-evaluable matrix at:

```text
packages.x86_64-linux.phenix-maintenance.phenixMaintenance.ci.matrix
```

GitHub Actions evaluates that matrix and runs each stage through:

```sh
nix run .#phenix-maintenance -- ci run <stage-id>
```

The provider currently emits three CI stages:

- `source` — source/static validation;
- `rust` — Clippy, unit, integration, and system commands run sequentially in one job so Cargo artifacts are reused;
- `product` — Nix-installed package/product smoke checks.

Unit, integration, and system remain distinct maintenance commands and are labelled separately in the Rust stage logs. Adding, removing, or regrouping a CI command is a Nix declaration change; the workflow does not maintain a second stage list.

The final `Maintenance checks` job remains the aggregate required status.

## Pre-commit

The repository hook applies only deterministic mechanical normalization and re-stages paths that were already staged. Inside `nix develop` it calls `maintenance fix`; outside the shell it falls back to:

```sh
nix develop --command maintenance fix
```

Compiler errors, judgment-bearing lint findings, test failures, runtime failures, and Nix evaluation/build failures are never auto-repaired.

## Stitch

Inspect the repository workspace graph with:

```sh
stitch workspace discover --json
```
