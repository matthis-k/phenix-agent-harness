# Phenix Harness example configuration

This directory is an **explicit example/authoring surface**, not built-in conductor policy and not a fallback selected by the packaged application.

A user may copy, reference or pass this directory explicitly with `--config-dir`. If no user configuration is supplied, Phenix does not silently install these workflows, routing tables, roles, backend choices or model choices.

```text
frontend-local Lua and definition files
        ↓ authoring declarations
    typed _phenix/config/apply
        ↓
phenix-conductor
    immutable configuration revision
        ↓
future session trees pin that revision
```

`config.lua` declares reusable Phenix ACP configuration: definitions, router selection, backend registrations and an optional `standard_session` adapter template. Concrete Phenix tree identities are created later through the session-tree API; they are not part of the reusable configuration.

Files below `workflows/` and `routing/` are source documents referenced by this example. Their content becomes authoritative only after a conductor accepts the corresponding configuration request.

## Workflow ownership

Managed workflows use a deterministic policy graph evaluated by `phenix-conductor`. ACP agents execute `invoke` states; they do not own graph topology, branching, joins, repair budgets, aliases, or terminal workflow state.

```text
| Key | Kind | Role | Required | Join | Objective | Next |
```

The supported state kinds are `invoke`, `decision`, `return`, and `fail`. `decision`, `return`, and `fail` are conductor operations and therefore do not create an ACP session. `return` and `fail` are terminal.

`Required` distinguishes mandatory evidence from optional evidence. `Join` is either `any` or `all-settled`; `all-settled` preserves successful, failed, cancelled, and skipped predecessor outcomes so synthesis can reason over partial evidence rather than collapsing the whole fanout into a generic failure.

`Next` is a semicolon-separated set of deterministic transitions. Conditions may inspect caller input, typed predecessor output, or predecessor outcome:

```text
implement if input.plan exists
plan if input.plan missing
repair if output.decision = repair
repository if output.domains contains repository
fallback if outcome = failure
```

Workflow invoke outputs are parsed as JSON when possible and are passed to downstream states in the conductor-created workflow context. Graph cycles are rejected; bounded repair therefore uses explicit `repair` and `recheck` states instead of an unbounded retry loop.

The example workflows apply these ownership rules:

- `workflow.implement` treats a caller-supplied `input.plan` as authoritative and skips its planner.
- Debugging cannot mutate after an inconclusive reproduction.
- Post-implementation reviewers return explicit accept/repair/fail decisions with one bounded repair/recheck path.
- QA waits for all evidence branches to settle and distinguishes mandatory from optional evidence.
- Research classifies relevant evidence domains before spawning research branches.
- Refactor architecture ownership and independent acceptance review use different roles.
- Deterministic terminal mapping uses `return`/`fail`; model finalizers remain only where semantic synthesis is actually required.
- `workflow.qa` is the canonical general review policy; there is no wrapper `workflow.review` that would add a redundant run-tree node.

## Routing format

Routing tables select a complete model configuration for each difficulty:

```text
| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
```

Every D0-D4 cell is:

```text
backend/provider/model/thinking
```

This example keeps the old role/model choices while making thinking level explicit per difficulty. Those choices are sample user policy, not conductor defaults.

The frontend can be replaced without moving runtime ownership. Other clients may configure the same conductor through the same Phenix ACP API without implementing Lua or sharing this directory layout.
