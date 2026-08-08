# Development

The repository uses devenv for its canonical maintenance graph. Nix provides the toolchain and reproducible build boundary; the application itself is the Rust workspace plus its Lua/Markdown authoring configuration.

## Development shell

```sh
nix develop
```

The shell contains the Rust, Nix, Lua, actionlint, Statix, and Stitch tooling needed for the current repository. It intentionally does not carry the retired in-repository TypeScript/Pi-extension toolchain.

## Canonical commands

Apply deterministic mechanical fixes:

```sh
devenv tasks run maintenance:fix
```

Run the complete validation graph:

```sh
devenv test
```

The equivalent explicit task is:

```sh
devenv tasks run maintenance:check
```

Pull-request CI automatically applies the same mechanical fix graph to same-repository branches before running validation. If normalization changes the tree, CI commits that normalization and validates the resulting commit in the follow-up run.

## Maintenance graph

| Task | Responsibility |
| --- | --- |
| `maintenance:format` | Verify canonical Nix and Rust formatting |
| `maintenance:statix` | Verify Nix static-analysis rules |
| `maintenance:workflows` | Validate GitHub Actions workflows with actionlint |
| `maintenance:tools` | Verify required maintenance executables |
| `maintenance:rust-compile` | Compile/check the complete Rust workspace |
| `maintenance:rust-clippy` | Run Clippy with warnings denied |
| `maintenance:rust-tests` | Run all Rust targets/tests |
| `maintenance:flake` | Run Nix flake checks and packaged smoke tests |
| `maintenance:check` | Aggregate the read-only validation graph |
| `maintenance:fix` | Apply safe Statix rewrites plus Nix/Rust formatting |

Formatting and safe static rewrites are mechanical. Compiler failures, Clippy findings requiring judgment, tests, runtime failures, and Nix evaluation/build failures must be fixed intentionally.

## Stitch

Inspect the repository workspace graph with:

```sh
stitch workspace discover --json
```
