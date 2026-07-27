# Development

## Shell

```sh
nix develop
```

The shell includes devenv, the Pi runtime toolchain, Stitch, and repository helpers.

## Verification

Run the complete read-only check suite:

```sh
devenv test
```

The explicit equivalent is:

```sh
devenv tasks run maintenance:check
```

Apply repository-owned mechanical fixes before reviewing the diff:

```sh
devenv tasks run maintenance:fix
```

After editing `modules/pi-npm/package.json`, refresh its independent lock:

```sh
update-pi-npm-lock
```

## Tasks

| Task | Checks |
| --- | --- |
| `maintenance:format` | Nix formatting and Biome rules |
| `maintenance:statix` | Nix static analysis |
| `maintenance:workflows` | GitHub Actions with actionlint |
| `maintenance:runtime` | Packaged Phenix runtime tests |
| `maintenance:typecheck` | TypeScript compilation |
| `maintenance:flake` | Complete flake checks |
| `maintenance:check` | All read-only checks |
| `maintenance:fix` | Statix and formatter fixes |

CI runs `devenv test`. Do not duplicate task selection in GitHub Actions or shell wrappers.

## Workspace

```sh
stitch workspace discover --json
```
