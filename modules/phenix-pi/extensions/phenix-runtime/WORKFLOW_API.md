# Agent-facing workflow API

`phenix_workflow` is the only model-facing entry point for workflow operations.
The active root session or child contract supplies actor identity, the current
workflow node, and delegation authority. The model never supplies those values.

## Initial authority bootstrap

Before inference starts, the runtime resolves the current authority and injects
the legal outgoing edges into the system prompt. This is the mandatory initial
inspection step; it is performed by deterministic code rather than requested by
the model.

The injected snapshot describes each legal edge, including its `edgeId`, kind,
purpose, allowed execution modes, and result contract. Models should use these
edges when delegation would materially improve the task.

## Invoke an edge

```json
{
  "edgeId": "planner.request-scout",
  "spawn": {
    "task": "Inspect the routing boundary.",
    "requirements": ["Return concrete evidence."],
    "mode": "await"
  }
}
```

The workflow runtime derives the current node afresh from the active session or
contract and verifies that the selected edge is still outgoing and legal. For a
spawn edge, the workflow and compiler layers derive the child role, preset,
provider/model route, thinking level, tools, child authority, output contract,
budgets, verification, and critic policy.

The model-facing request cannot override those derived values and does not
contain a node ID, actor identity, role, model, or permission patch.

## Extension rule

New workflow capabilities should be represented as new edge kinds behind the
same `edgeId + edge-specific input` envelope. They should not introduce unrelated
top-level tools or expose the generic child-session runtime. This permits later
state-transition, join, approval, cancellation, or execution-inspection edges
while preserving the same authority-bound interaction model.
