# Development

The repository uses [Tend](https://github.com/matthis-k/phenix-tend) as the sole task-selection and quality-assurance interface. Nix provides dependencies, builds, and the reproducibility boundary; repository scripts and individual Nix check derivations are Tend implementation details rather than parallel developer workflows.

## Enter the development shell

```sh
nix develop
```

The shell contains Tend, the Pi runtime tools, TypeScript and Node.js, and every formatter or linter referenced by `.tend.json`.

## Canonical commands

| Profile | Purpose | Mutates files | Command |
| --- | --- | --- | --- |
| `git-hook` | Fast checks for staged files | No | `tend check --profile git-hook --staged --offline --locked` |
| `manual` | Changed-task development checks with Tend caching | No | `tend check --profile manual` |
| `pre-push` | Complete reproducible gate | No | `tend check --profile pre-push --locked` |
| `ci` | CI range checks plus the complete reproducible gate | No | `tend check --profile ci --locked` |
| `fix` | Explicit staged formatting fixes | Yes | `tend check --profile fix --staged` |
| `nix-check` | Direct recursion-safe checks inside `nix flake check` | No | Internal only |

Use these Tend profiles for routine development, hooks, and CI. Do not add new top-level check wrappers or duplicate task selection in GitHub Actions, shell scripts, or Nix applications.

`nix-check` deliberately excludes commands that invoke `nix flake check`. The Nix derivation prepares the packaged Pi dependencies and then asks Tend to run the direct TypeScript, runtime, formatter, linter, shell, and workflow checks.

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

Both hooks invoke Tend profiles. The pre-commit hook is non-mutating; formatting changes are explicit through the `fix` profile.
