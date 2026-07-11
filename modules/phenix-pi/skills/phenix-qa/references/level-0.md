# Level 0 — Parse, Build, and Basic Correctness

Verify that the code can be parsed, type-checked, built, and tested.

## Checks

- Parse errors.
- Compilation errors.
- Type-checking failures.
- Missing imports.
- Unresolved symbols.
- Invalid configuration.
- Broken generated-code contracts.
- Failing tests.
- Invalid formatting where formatting is enforced.
- Invalid serialization schemas.
- Invalid API or interface implementations.
- Unreachable or obviously dead code.

## Commands

Prefer project-native commands. Discover them from the repository's build system:

```text
build
typecheck
test
lint
format-check
```

Examples by ecosystem:

| Ecosystem | Build | Typecheck | Test | Lint | Format |
|-----------|-------|-----------|------|------|--------|
| Nix | `nix flake check` | `nix flake check` | (in check) | `nix fmt -- --check` | `nix fmt -- --check` |
| Node/TS | `npm run build` | `npx tsc --noEmit` | `npm test` | `npx eslint .` | `npx prettier --check .` |
| Rust | `cargo build` | `cargo check` | `cargo test` | `cargo clippy -- -D warnings` | `cargo fmt -- --check` |
| Python | — | `mypy .` | `pytest` | `ruff check .` | `ruff format --check .` |
| Go | `go build ./...` | `go vet ./...` | `go test ./...` | `golangci-lint run` | `gofmt -d .` |

## Report format

For each command executed:

- Command executed.
- Exit status.
- Relevant diagnostics (first 20 lines of error output).
- Affected files.
- Whether the failure appears related to the current change.

## Blocking

Level 0 failures are normally blocking. The review may continue to higher levels if the failure is:

- Pre-existing (not introduced by the current change).
- Limited to files outside the review scope.
- A known issue with a tracking ticket.

State the reason for continuing past a Level 0 failure explicitly.
