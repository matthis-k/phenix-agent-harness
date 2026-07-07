---
description: Cycle the active routing mode
agent: phenix-workflow
subtask: true
---

Cycle the active routing mode.

> **Note**: Model routing is currently a policy/guidance system, not automated
> runtime behaviour. The routing mode (mixed/go/plus/free/manual) is an advisory
> construct — the workflow agent uses it as a recommendation when building task
> packets, but there is no automated model slot resolution or runtime model
> switching at the OpenCode wrapper level.

If the task context is private, secret, or security-sensitive, skip the `free`
mode.

Current routing context (populated by workflow agent's task classification):

- mode: {routing_mode}
- difficulty: {difficulty}
- secrecy: {secrecy}
- change_kind: {change_kind}

Cycle order: mixed -> go -> plus -> free -> manual -> mixed

If free is unsafe for the current context, remove it from the cycle:

  mixed -> go -> plus -> manual -> mixed

Display a compact status message:

- `routing: mixed`
- `routing: go-only`
- `routing: plus-only`
- `routing: free skipped: {reason}`
- `routing: manual`

Return the new routing context:

```yaml
status: cycled
previous_mode: {routing_mode}
new_mode: <cycled mode>
free_skipped: true | false
free_skip_reason: |-
```
