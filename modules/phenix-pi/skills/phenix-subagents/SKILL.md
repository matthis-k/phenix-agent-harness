---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix workflow

Phenix workflow nodes, legal transitions, configured-agent availability,
delegation depth, role authority, output schemas, model routing, verification,
critics, and repair limits are owned by the TypeScript runtime.

Before the model starts, the runtime resolves the current root-session or child-
contract authority and injects the target agents that may be spawned from the
current workflow node into the system prompt. This is the mandatory initial
authority inspection. Do not call a listing operation and do not send a node or
transition ID back to the runtime.

Use the single `phenix_workflow` interface with:

- `action: "spawn"`;
- one advertised target `agent`;
- a bounded `task`, with optional requirements and execution mode.

The runtime derives the current node from the active root session or child
contract, resolves fresh authority, maps the requested target agent to the unique
legal transition, then derives the child role, model, thinking level, output
schema, tools, budgets, verification, and critic gates. Use an advertised target
agent when delegation would materially improve evidence, planning,
implementation, testing, or review. Never invent or cache workflow authority,
and never supply arbitrary child-session configuration.

Each accepted child must finish through `phenix_complete`.
