# Development

The repository uses a standalone devenv task graph for maintenance. Nix provides the toolchain, build closures, and reproducibility boundary; `maintenance.nix` is the canonical source for local and CI checks.

## Enter the development shell

```sh
nix develop
```

The shell includes devenv, the Pi runtime toolchain, Stitch, and the repository helpers shown at startup.

## Canonical commands

Run the complete read-only maintenance graph:

```sh
devenv test
```

The equivalent explicit task is:

```sh
devenv tasks run maintenance:check
```

Apply the repository-owned mechanical fixes, then review the resulting diff:

```sh
devenv tasks run maintenance:fix
```

Update the independently locked Pi extension dependencies after editing `modules/pi-npm/package.json`:

```sh
update-pi-npm-lock
```

## Maintenance graph

| Task | Responsibility |
| --- | --- |
| `maintenance:format` | Check Nix formatting and Biome formatting/lint rules |
| `maintenance:statix` | Check Nix static-analysis rules |
| `maintenance:workflows` | Validate GitHub Actions workflows with actionlint |
| `maintenance:runtime` | Build and run the packaged Phenix runtime tests |
| `maintenance:typecheck` | Build the TypeScript compiler gate |
| `maintenance:flake` | Run the complete flake check |
| `maintenance:check` | Aggregate every read-only maintenance task |
| `maintenance:fix` | Apply statix and formatter fixes |

Do not duplicate task selection in GitHub Actions, shell wrappers, or extra Nix applications. CI installs devenv and runs `devenv test`, so local and remote verification use the same graph.

## Stitch

Inspect the repository workspace graph with:

```sh
stitch workspace discover --json
```
