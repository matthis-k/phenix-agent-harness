# Development

The repository uses [Tend](https://github.com/matthis-k/phenix-tend) as the task-selection and execution layer. Nix remains the dependency and reproducibility boundary.

## Enter the development shell

```sh
nix develop
```

The shell contains Tend, the Pi runtime tools, TypeScript and Node.js, and every formatter or linter referenced by `.tend.json`.

## Profiles

| Profile | Purpose | Mutates files | Typical command |
| --- | --- | --- | --- |
| `git-hook` | Fast checks for staged files | No | `tend check --profile git-hook --staged --offline --locked` |
| `pre-push` | Complete flake gate | No | `tend check --profile pre-push --locked` |
| `manual` | Changed-task development checks with Tend caching | No | `tend check --profile manual` |
| `nix-check` | Direct, recursion-safe checks inside `nix flake check` | No | Run by the `tend-nix-check` flake check |
| `fix` | Explicit staged formatting fixes | Yes | `tend check --profile fix --staged` |
| `ci` | Complete CI-equivalent flake gate | No | `tend check --profile ci --locked` |

`nix-check` deliberately excludes commands that invoke `nix flake check`. The Nix derivation prepares the packaged Pi dependencies and then runs the direct TypeScript, runtime, formatter, linter, shell, and workflow checks through Tend.

## Inspect the task graph

```sh
tend status
tend tree
tend plan --profile manual
tend validate --profiles
```

## Git hooks

Install the repository-managed hooks once:

```sh
setup-git-hooks
```

The pre-commit hook is non-mutating. Formatting changes remain explicit through the `fix` profile or `phenix-fix-staged`.
