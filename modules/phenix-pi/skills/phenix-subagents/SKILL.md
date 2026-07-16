---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix workflow

Phenix workflow nodes, legal edges, configured-agent availability, delegation
depth, role authority, output schemas, model routing, verification, critics, and
repair limits are owned by the TypeScript runtime.

Before the model starts, the runtime resolves the current root-session or child-
contract authority and injects the legal outgoing workflow edges into the system
prompt. This is the mandatory initial authority inspection. Do not call a listing
operation and do not send a node ID back to the runtime.

Use the single `phenix_workflow` interface with:

- one advertised `edgeId`;
- the edge-specific input. A spawn edge requires `spawn.task` and may accept
  bounded requirements and an execution mode.

The runtime derives the current node from the active root session or child
contract, resolves fresh authority, verifies that the requested edge is still
legal, then derives the child role, model, thinking level, output schema, tools,
budgets, verification, and critic gates. Use a legal edge when delegation would
materially improve evidence, planning, implementation, testing, or review.
Never invent or cache workflow authority, and never supply arbitrary child-
session configuration.

Each accepted child must finish through `phenix_complete`.
