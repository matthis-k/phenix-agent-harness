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
schema, tools, budgets, verification, and critic gates.

Delegate when a bounded child can absorb substantial intermediate context whose
underlying details are not needed for your remaining work, or when independent
execution materially improves evidence, planning, implementation, testing, or
review. Broad reconnaissance is a strong candidate when it can be compressed to
relevant files, symbols, constraints, excluded areas, and uncertainties.
Mechanical execution is a strong candidate after the plan and scope are settled.

Keep decision-critical source inspection and reasoning in the agent responsible
for architecture, integration, acceptance, or final synthesis when those details
must remain available downstream. After scouting identifies the relevant files,
read the files required for your own task. Do not delegate trivial work or work
you would need to repeat after the handoff.

Never invent or cache workflow authority, and never supply arbitrary child-
session configuration. Each accepted child must finish through
`phenix_complete`.
