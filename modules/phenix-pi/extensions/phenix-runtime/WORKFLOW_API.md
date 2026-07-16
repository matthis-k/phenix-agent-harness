# Agent-facing workflow API

`phenix_workflow` is the only model-facing entry point for workflow operations.
The active root session or initialized child contract supplies actor identity, the
current workflow node, and delegation authority. The model never supplies those
values.

## Initial authority bootstrap

Before inference starts, the runtime resolves the current authority and injects
the target agents that may be spawned from the current workflow node into the
system prompt. This is the mandatory initial inspection step; it is performed by
deterministic code rather than requested by the model.

The injected snapshot describes each target agent, including its public identity,
execution role, purpose, allowed execution modes, and result contract. Models
should use these targets when delegation would materially improve the task.

## Refresh current authority

After a workflow action may have changed the current node or legal target set, the
model can request a fresh deterministic projection:

```json
{
  "action": "inspect"
}
```

The result is derived from the active root session or initialized child contract.
It exposes the current node, legal target agents, result schemas, modes, remaining
depth, and effective tools, but never exposes private transition identities or
lets the model mutate authority.

## Spawn a target agent

```json
{
  "action": "spawn",
  "agent": "scout",
  "task": "Inspect the routing boundary.",
  "requirements": ["Return concrete evidence."],
  "mode": "await"
}
```

The workflow runtime derives the current node afresh from the active session or
contract. The pair `(current node, target agent)` resolves to exactly one legal
internal transition. The workflow and compiler layers then derive the child role,
preset, provider/model route, thinking level, tools, child authority, output
contract, budgets, verification, and critic policy.

The model-facing request cannot override those derived values and does not
contain a node ID, transition ID, actor identity, role, model, or permission
patch.

A workflow may expose a specialized target identity such as `planner-scout` or
`repository-scout` while still executing it with the shared `scout` role and
preset. This lets workflows specialize delegation without expanding the public
call shape.

## Extension rule

New workflow capabilities should be represented as additional workflow actions,
not unrelated top-level tools or direct access to the generic child-session
runtime. Inspect and spawn preserve the same authority-bound interaction model
while internal transition IDs remain private implementation details.
