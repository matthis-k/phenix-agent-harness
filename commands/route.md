---
description: Cycle the active routing mode
agent: phenix-workflow
subtask: true
---

Cycle the persisted active routing mode with `phenix-route cycle --json`.

The route state is stored under XDG state (`$XDG_STATE_HOME/phenix-agent-harness/routing.json`,
or `$HOME/.local/state/phenix-agent-harness/routing.json`). The OpenCode wrapper reads that
state and applies the effective generated config only when a new OpenCode process
starts. Hot switching is not supported. Restart OpenCode to apply a changed route
state to model slots.

If the task context is Private, Secret, D2, D3, Secrets, Auth, Ci, Security,
MainBound, or a commit/sync/push operation, skip the `free-only` mode.

Current routing context (populated by workflow agent's task classification):

- mode: {routing_mode}
- difficulty: {difficulty}
- secrecy: {secrecy}
- change_kind: {change_kind}

Cycle order: mixed -> gpt-only -> go-only -> free-only -> manual -> mixed

If free-only is unsafe for the current context, remove it from the cycle:

  mixed -> gpt-only -> go-only -> manual -> mixed

Display the compact status from `phenix-route`:

- `routing: mixed`
- `routing: gpt-only`
- `routing: go-only`
- `routing: free skipped: {reason}`
- `routing: manual`

Return the new routing context:

```yaml
status: cycled
previous_mode: {routing_mode}
new_mode: <cycled mode>
free_skipped: true | false
free_skip_reason: |-
restart_required: true
hot_switching_supported: false
runtime_enforced: process_start_expected
```
