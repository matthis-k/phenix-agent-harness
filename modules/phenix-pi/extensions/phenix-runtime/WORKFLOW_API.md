# Agent-facing workflow API

`phenix_workflow` is the only model-facing entry point for workflow operations.
The current root session or child contract supplies actor identity and authority;
the model never supplies those values.

## Inspect the current node

```json
{
  "action": "inspect"
}
```

Inspection returns one current `nodeId` and the legal outgoing `edgeId`s. Each
edge declares its kind, source node, accepted target node, and required input.
The current implementation exposes spawn edges; state-only edge kinds can be
added behind the same graph contract later.

## Take an edge

```json
{
  "action": "take",
  "nodeId": "planning",
  "edgeId": "planner.request-scout",
  "spawn": {
    "task": "Inspect the routing boundary.",
    "requirements": ["Return concrete evidence."],
    "mode": "await"
  }
}
```

`nodeId` is an optimistic concurrency guard. The adapter refreshes authority,
rejects the call when the actor has moved to another node, and verifies that the
requested edge is still outgoing and legal. For a spawn edge, the workflow and
compiler layers derive the child role, preset, provider/model route, thinking
level, tools, child authority, output contract, budgets, verification, and
critic policy.

The model-facing request cannot override those derived values.

## Extension rule

New workflow capabilities should be represented as new edge kinds and handled
behind `action: "take"`. They should not introduce unrelated top-level tools or
expose the generic child-session runtime. This permits later state-transition,
join, approval, cancellation, or execution-inspection edges while preserving the
same node-and-edge interaction model.
