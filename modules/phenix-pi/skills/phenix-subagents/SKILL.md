---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix workflow

Phenix workflow nodes, legal edges, configured-agent availability, delegation
depth, role authority, output schemas, model routing, verification, critics, and
repair limits are owned by the TypeScript runtime.

Use the single `phenix_workflow` interface:

- `action: "inspect"` returns the exact current `nodeId` and legal outgoing
  `edgeId`s.
- `action: "take"` accepts that current `nodeId`, one returned `edgeId`, and the
  edge-specific input. A spawn edge requires `spawn.task` and may accept bounded
  requirements and an execution mode.

The current root session or child contract supplies the actor and authority
scope. The runtime revalidates the expected node and edge, then derives the
child role, model, thinking level, output schema, tools, budgets, verification,
and critic gates. Never invent or cache workflow authority, and never supply
arbitrary child-session configuration.

Each accepted child must finish through `phenix_complete`.
