---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix workflow

Phenix workflow states, legal actions, configured-agent availability, delegation
depth, role authority, output schemas, model routing, verification, critics, and
repair limits are owned by the TypeScript runtime.

Use the single `phenix_workflow` interface:

- `action: "inspect"` returns the exact current actor, workflow state, and legal
  actor-scoped delegation names.
- `action: "delegate"` accepts one returned `agent` name, a bounded `task`, and
  optional requirements and execution mode.

The current root session or child contract supplies the lookup scope. The
runtime resolves the local agent name to an internal workflow transition and
then derives the child role, model, thinking level, output schema, tools,
budgets, verification, and critic gates. Never invent or cache workflow
authority, and never supply arbitrary child-session configuration.

Each accepted child must finish through `phenix_complete`.
