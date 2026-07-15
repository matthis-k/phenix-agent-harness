---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix subagents

Phenix workflow states, legal transitions, configured-agent availability,
delegation depth, role authority, output schemas, model routing, verification,
critics, and repair limits are owned by the TypeScript runtime.

Call `phenix_workflow` immediately before deciding whether to create a child.
It returns the exact current workflow state, legal transitions, contract-derived
roles, remaining depth, and effective tool authority. Select one returned
transition and call `phenix_create_subagent` with only its transition ID, bounded
task, and optional narrowing. The runtime binds the current revision and
authority digest and derives the child role, model, thinking level, output
schema, tools, budgets, verification, and critic gates. Do not invent or cache
workflow authority.

Each accepted child must finish through `phenix_complete`.
