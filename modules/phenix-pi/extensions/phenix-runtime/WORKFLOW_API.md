# Agent-facing workflow API

`phenix_workflow` is the only model-facing entry point for workflow operations.
The current root session or child contract supplies actor identity and authority;
the model never supplies those values.

## Inspect

```json
{
  "action": "inspect"
}
```

Inspection returns the current actor and state plus the actions that are legal
at that instant. Delegation entries use names scoped to the current actor, for
example `scout` or `repository-scout`. Internal transition IDs, workflow
authority digests, and persistence identities are intentionally omitted.

## Delegate

```json
{
  "action": "delegate",
  "agent": "scout",
  "task": "Inspect the routing boundary.",
  "requirements": ["Return concrete evidence."],
  "mode": "await"
}
```

The adapter refreshes authority, resolves `agent` within the current actor's
outgoing workflow actions, and injects the internal transition identity,
revision, and authority digest. The workflow/compiler layers then derive the
child role, preset, provider/model route, thinking level, tools, child
authority, output contract, budgets, verification, and critic policy.

The model-facing request cannot override those derived values.

## Extension rule

New workflow capabilities extend the discriminated `action` union and are
implemented behind the same authority-bound port. They should not introduce a
new top-level tool unless they are not workflow operations. This permits later
state-change or execution-inspection actions without exposing the generic
subagent runtime or persistence model.
