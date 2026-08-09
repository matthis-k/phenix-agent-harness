# Phenix Harness example configuration

This directory is an **explicit example/authoring surface**, not built-in conductor policy and not a fallback selected by the packaged application.

A user may copy, reference, or pass this directory explicitly with `--config-dir`. If no user configuration is supplied, Phenix does not silently install these workflows, routing tables, roles, backend choices, or model choices.

```text
structured Lua authoring policy
            ↓
    typed _phenix/config/apply
            ↓
      phenix-conductor
    immutable configuration revision
            ↓
 future session trees pin that revision
```

`config.lua` is the complete first-class example policy. It defines the downstream ACP backend, shared base agents, native Phenix workflows, Matt Pocock-inspired workflow structures, and D0-D4 model/thinking policy. There is no separate `legacy` workflow or routing layer.

The Lua API accepts structured definitions directly:

```lua
phenix.acp.workflow({
  id = "workflow.example",
  title = "Example",
  steps = {
    {
      key = "inspect",
      role = "scout",
      objective = "Inspect {objective}",
    },
  },
})
```

Routing tables use the same authoring model with explicit `d0` through `d4` cells. Lua is an authoring surface only: the conductor still parses, validates, owns, and freezes the resulting immutable configuration revision.

## Shared base agents

The workflow library intentionally reuses a small role vocabulary:

- `coordinator`
- `scout`
- `planner`
- `architect`
- `implementer`
- `tester`
- `critic`
- `verifier`
- `finalizer`
- `qa-synthesizer`

These roles are shared by both native Phenix workflows and the Matt-inspired procedures. A procedure contributes workflow structure and a bounded objective; it does not create a parallel agent taxonomy. Model selection is kept out of agent prose and remains routing policy.

The earlier Phenix authority split is preserved as part of those shared contracts. `coordinator`, `scout`, `planner`, `architect`, `tester`, `critic`, and `verifier` are read-only roles. `implementer` owns bounded code, test, and instrumentation mutations. `finalizer` and `qa-synthesizer` synthesize established evidence rather than mutating implementation files. Matt-inspired workflows therefore route test creation and diagnostic instrumentation through `implementer` instead of silently widening `tester` permissions.

## Native Phenix workflows

The current Lua catalog restores the native Phenix workflow family as first-class definitions:

```text
workflow.implement
workflow.qa
workflow.qa-fix
workflow.debug
workflow.design
workflow.migrate
workflow.refactor
workflow.research
workflow.review
workflow.security
workflow.ui-change
```

The intent of the earlier Phenix workflows is preserved while adapting them to the current ACP session-tree model. In particular:

- `workflow.implement` keeps the plan → implement → independent verification separation.
- `workflow.qa` keeps independent repository, test, architecture, and security reviews followed by QA synthesis.
- `workflow.qa-fix` extends QA with bounded repair planning, implementation, independent verification, and a final evidence handoff.
- `workflow.debug`, `workflow.review`, and `workflow.research` use stronger procedure structures derived from Matt Pocock's skills while remaining native Phenix workflows over the same base agents.

The retired workflow runtime had richer typed transitions such as a D0 fast path, conditional QA repair, joins, and bounded repair loops. The current ACP workflow plan is a static delegated-session tree. This configuration does not fake those control-flow semantics in prompt prose; richer control flow should be represented by typed workflow-kernel features when the current runtime exposes them.

## Difficulty policy

Difficulty is first-class typed runtime data in the current ACP design. A workflow starts with D0-D4, and routing resolves a complete model configuration from:

```text
role × workflow × difficulty
```

Each route selects:

```text
backend/provider/model/thinking
```

Generic role routes follow the requested workflow difficulty:

```text
D0 → minimal
D1 → low
D2 → medium
D3 → high
D4 → max
```

QA also restores the earlier policy of deliberately capable review routes. Workflow-specific routing rows pin repository/test review to D2-class configurations and architecture/security/synthesis to D3-class configurations, even when the caller selected a lower difficulty. Repair planning and implementation in `workflow.qa-fix` continue to use the caller's requested difficulty.

Available example routing tables are:

```text
router.mixed
router.opencode-go
router.chatgpt-plus
router.free
```

`router.mixed` is selected by default.

## Matt-inspired workflow structures

The additional procedures adapt the most reusable structures from `mattpocock/skills` without creating workflow-specific agents:

```text
workflow.grill
workflow.spec
workflow.tickets
workflow.tdd
workflow.architecture
workflow.domain-model
workflow.wayfinder
```

The overlapping skills strengthen native Phenix workflows instead of creating duplicates:

- `workflow.debug`: reproduce → minimize → hypothesize → diagnostic plan → instrumentation → evidence → fix → regression.
- `workflow.review`: independent engineering-standards and spec-conformance branches.
- `workflow.research`: independent source gathering, counterevidence, challenge, and synthesis.

Other useful structures remain explicit:

- `workflow.tdd`: red-plan → red → green → refactor → verify. The read-only tester identifies the seam; the implementer creates the failing test.
- `workflow.spec`: repository context → stable seams → specification → independent verification.
- `workflow.tickets`: pre-factor analysis → tracer-bullet decomposition → challenge → publish.
- `workflow.wayfinder`: reconnaissance → decision map → high-leverage resolution → frontier verification.

A typical idea-to-implementation progression is therefore:

```text
workflow.grill
    ↓
workflow.spec
    ↓
workflow.tickets
    ↓
workflow.implement
    ↓
workflow.review
```

Upstream procedural inspiration: `https://github.com/mattpocock/skills`.

## Ownership boundary

The frontend evaluates Lua and submits the authored definitions through the typed Phenix ACP configuration request. The conductor constructs and owns the immutable runtime revision. Existing session trees remain pinned to the revision under which they were created.

The frontend can therefore be replaced without moving runtime ownership, and other clients can configure the same conductor through the same Phenix ACP control plane.
