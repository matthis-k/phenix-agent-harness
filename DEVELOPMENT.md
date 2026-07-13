# Development

The repository uses [Tend](https://github.com/matthis-k/phenix-tend) as the sole task-selection and quality-assurance interface. Nix provides dependencies, builds, and the reproducibility boundary. Shell scripts and individual Nix derivations are private task implementations rather than parallel workflows.

## Enter the development shell

```sh
nix develop
```

The shell contains Tend, the Pi runtime tools, TypeScript and Node.js, and every formatter or linter referenced by `.tend.json`.

## Canonical commands

Every Tend invocation selects two independent dimensions:

- `--profile` selects what should run.
- `--context` selects how it should run.

| Profile | Selection | Purpose | Command |
| --- | --- | --- | --- |
| `git-hook` | Staged | Fast pre-commit checks | `tend check --profile git-hook --context local` |
| `manual` | Changed | Incremental development checks | `tend check --profile manual --context local` |
| `full` | Full | Complete direct verification task set | `tend check --profile full --context local` |
| `pre-push` | Full | Reproducible Nix flake gate | `tend check --profile pre-push --context local` |
| `ci` | Git range | CI diagnostics and reproducible gate | `tend check --profile ci --context local --base <sha> --head <sha>` |
| `fix` | Staged | Explicit staged-file formatting | `tend check --profile fix --context local` |

The Nix sandbox invokes the same logical `full` profile with a different mechanism:

```sh
tend check --profile full --context nix-sandbox
```

This selects the direct runtime-test and TypeScript implementations and excludes the recursive flake gate by profile membership. There is no separate sandbox-specific task graph.

Do not add top-level check wrappers or duplicate task selection in GitHub Actions, hooks, shell scripts, or Nix applications.

## Inspect the configured model

```sh
tend validate
tend list
tend plan --profile manual --context local
tend plan --profile full --context nix-sandbox
```

## Git hooks

Install the repository-managed hooks once:

```sh
setup-git-hooks
```

Both hooks invoke Tend profiles. The pre-commit hook is non-mutating; formatting changes are explicit through the `fix` profile.
