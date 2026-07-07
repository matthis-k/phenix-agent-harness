# Phenix agent routing

Phenix routing is represented by one WorkScope routing packet plus persisted route
state for the OpenCode wrapper.

## State location

By default, `phenix-route` stores runtime route state in XDG state only:

- `$XDG_STATE_HOME/phenix-agent-harness/routing.json`; or
- `$HOME/.local/state/phenix-agent-harness/routing.json`.

Tests and checks that need an isolated state file must pass explicit `--state`.

The harness must not write repo-local route state.

## Runtime behavior

The `opencode` wrapper reads the persisted state at process start, generates an
OpenCode config overlay with resolved agent model slots, and exports it through
`OPENCODE_CONFIG_CONTENT` when that variable is not already set.

Hot switching is not supported. After changing route state, quit and restart
OpenCode before expecting model-slot changes to apply.

## CLI

```sh
phenix-route show
phenix-route show --json
phenix-route set mixed --difficulty D1 --secrecy Public --change-kind Workflow
phenix-route cycle --json --difficulty D1 --secrecy Public --change-kind Workflow
phenix-route resolve --json --difficulty D1 --secrecy Public --change-kind Workflow
phenix-route reset
```

Valid modes are exactly `mixed`, `gpt-only`, `go-only`, `free-only`, and
`manual`. `cycle` follows `mixed -> gpt-only -> go-only -> free-only -> manual
-> mixed`. When `free-only` is unsafe, cycle skips it:
`mixed -> gpt-only -> go-only -> manual -> mixed`.

The state JSON schema contains `version`, `mode`, `updated_at`, `updated_by`,
`manual_slots`, and `last_context`. Missing state defaults to `mixed`; invalid
JSON warns and falls back; unknown modes fail validation.

`resolve --json` returns `status: denied` for unsafe `free-only` rather than
silently falling back. Unsafe contexts include Private, Secret, D2, D3, Secrets,
Auth, Ci, Security, MainBound, and commit/sync/push operations. `manual` uses
persisted `manual_slots` and returns `status: incomplete` until all required
role slots are present.

## Slot vocabulary

The resolver uses logical slot identifiers, not private account-specific model IDs:

- `gpt-normal`, `gpt-strong`
- `opencode-go`, `opencode-go-strong`
- `free-normal`
- `denied-until-explicit-user-request` for commit/sync until the WorkScope and user
  request explicitly permit it

The workflow agent is special: routing may report a workflow recommendation, but
the generated overlay does not set `phenix-workflow.model`, so the wrapper does
not unexpectedly change the user-facing entrypoint model.

The WorkScope remains the semantic source of truth for capabilities, invariants,
boundaries, and escalation. Routing only selects agent slots and records denied
routes; it does not grant edit, commit, push, publish, deploy, or secret access.
