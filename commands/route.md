---
description: Cycle the active routing mode
agent: phenix-workflow
subtask: true
---

Cycle the active routing mode.

If the task context is private, secret, or security-sensitive, skip the `free`
mode.

Current routing context:

- mode: $ROUTING_MODE
- difficulty: $DIFFICULTY
- secrecy: $SECRECY
- change_kind: $CHANGE_KIND

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
previous_mode: $ROUTING_MODE
new_mode: <cycled mode>
free_skipped: true | false
free_skip_reason: |-
```
