# Phenix agent harness instructions

## Use the current implementation

- Treat executable code and deterministic tests as authoritative.
- Update user-facing documentation when behavior changes.
- Remove obsolete aliases and stale compatibility paths instead of preserving them.
- Agent and workflow definitions live in their Markdown source files.

## Execution rules

- Substantial root work starts through `phenix_dispatch`; normal selection uses `mode=auto`.
- `qa`, `implement`, and `coordinate` are explicit operator overrides.
- The root session has no direct shell authority.
- Child tools, invokable definitions, limits, and delegation depth come from the compiled run specification.
- Workflow children start only from declared workflow states.
- Follow-up input may be routed to active agent sessions. Workflow runs are not direct steering targets.
- Children start attached. Cancellation cascades, and a parent cannot finish while an attached child is active.
- Success requires a schema-valid result. Failed runs remain immutable; retry creates a linked replacement.
- Tool or limit overrides apply only to a failed terminal agent retry. Read-only retries must not gain `edit` or `write`.
- `local.qa-checks` accepts structured deterministic checks. Arbitrary commands require an agent compiled with `bash` or `nix_shell`.
- Prompt text guides behavior but does not grant permissions.

## Change rules

- Prefer an existing library or platform primitive when it already fits.
- Keep modules focused and name concepts after their behavior.
- Avoid generic wrappers that add neither policy nor a replaceable dependency.
- Add regression tests for lifecycle races, authorization, persistence, recovery, attention delivery, diagnostics, and presentation deduplication when those areas change.
- Keep CI read-only. Apply mechanical fixes locally.
- Pin third-party GitHub Actions to full commit SHAs with a version comment.

## Verify

```sh
devenv tasks run maintenance:fix
devenv test
```

A change is incomplete while formatting, typechecking, runtime tests, workflow validation, packaging, or flake evaluation fails.
