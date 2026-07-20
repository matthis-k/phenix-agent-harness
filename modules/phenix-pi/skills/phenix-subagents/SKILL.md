---
name: phenix-subagents
description: Use whenever the user explicitly requests Phenix workflows, delegation, or subagents. Also use for bounded isolated work that materially reduces context.
---

# Phenix workflow

Phenix workflow nodes, legal transitions, configured-agent availability,
delegation depth, role authority, output schemas, model routing, verification,
critics, repair limits, and task-subtree ownership are owned by the TypeScript
runtime.

Before the model starts, the runtime resolves the current root-session or child-
contract authority and injects the target agents that may be spawned from the
current workflow node. Required `SKILL.md` files may be read locally before
spawning. Skill loading, contract loading, workflow inspection, and other Phenix
harness preparation are not delegated tasks. When authority includes required
transitions, a turn-scoped runtime gate blocks repository execution until
`phenix_workflow` is called with one required target. For required root
transitions, the model-provided `task` is only a focus hint: the runtime builds
the child assignment from the transition purpose and the complete user request.
After every spawn result, the runtime resolves authority again and either
enforces the next required transition or records a terminal workflow failure.

When the user explicitly asks to use subagents, delegation, or the Phenix
workflow, do not silently continue as a single agent. After local skill preflight,
your first substantive execution action must use `phenix_workflow` to spawn an
advertised target for the user's actual task. Use `action: "inspect"` only when
no required transition is pending and a prior workflow action may have changed
optional authority. If spawning fails, surface the exact runtime/provider error
and do not claim subagents were used. A terminal failed workflow does not permit
further execution in the same turn; report the failure and retry from a new user
turn.

Do not send a node or transition ID back to the runtime. Use the primary
`phenix_workflow` interface with:

- `action: "spawn"`;
- one advertised target `agent`;
- a concise `task` focus tied to the user request, with optional requirements and
  execution mode. Required root scope remains owned by the runtime.

`phenix_subagent` is an optional convenience tool. Use it only when the current
workflow node advertises exactly one legal target. It still executes through the
workflow runtime and never bypasses contracts, routing, task ownership, or
verification. Raw `subagent` remains unmanaged and is blocked in Phenix sessions.

Root workflow spawns are handle-first: unless `mode: "await"` is explicitly
requested, `phenix_workflow` and `phenix_subagent` return immediately with a
persistent `handleId`. Keep that ID and use `phenix_agent` with `inspect`, `poll`,
`await`, `send`, or `cancel`. Use `await` to collect the final structured handoff;
do not spawn a replacement child merely to retrieve an existing result. Use
`send` only for concise clarification or steering while the child is live. Nested
child delegation remains foreground by default because child actors must consume
that handoff before continuing their own contract.

The runtime derives the current node from the active root session or child
contract, resolves fresh authority, maps the requested target agent to the unique
legal transition, then derives the child role, model, thinking level, output
schema, tools, budgets, verification, critic gates, assignment, and owned task
subtree.

Use `phenix_tasks` to keep that subtree synchronized with actual execution. Add
bounded child tasks before independent work, mark a task `wip` when beginning it,
and mark it `done` immediately after completion and verification. Do not use the
tree as a narrative log. A child may update its assigned task and descendants,
but cannot update ancestors or sibling subtrees. Spawning a child automatically
creates and assigns its task; do not manually mark a delegation task WIP first.

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

Never invent or cache workflow or task authority, and never supply arbitrary
child-session configuration. Each accepted child must finish through
`phenix_complete` after completing its owned task subtree.
