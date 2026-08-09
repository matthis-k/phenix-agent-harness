# Development

The flake is the single owner of the development toolchain, maintenance provider, Nix package checks, and shipped products. There is no separate devenv environment or lockfile.

Repository maintenance is declared once in Nix through Phenix Flake Maintenance and materialized as the namespaced flake provider `packages.<system>.phenix-maintenance`. The generated executable is `maintenance`; local development and CI invoke the same command implementations.

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

Commands remain declared and implemented by the Nix maintenance provider. GitHub Actions owns only CI scheduling and presentation, so architectural boundaries are visible as real jobs/steps instead of being hidden inside one runtime-discovered shell step.

The workflow is intentionally chunked as:

```text
Source
  └─ Source validation

Rust
  ├─ Clippy
  ├─ Unit tests
  ├─ Integration tests
  └─ System tests

Product
  └─ Product tests

Maintenance checks
  └─ aggregate required status
```

The Rust commands stay in one job and share `CARGO_HOME` and `CARGO_TARGET_DIR`, preserving incremental Cargo artifacts while retaining separate GitHub step timing and failure attribution.

The workflow does not duplicate Cargo/Nix implementation details: each visible step invokes the corresponding generated `phenix-maintenance` command. The provider's `phenixMaintenance.ci` metadata remains available to other CI integrations, but GitHub step topology is static because Actions must know jobs and steps before runtime evaluation begins.

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
