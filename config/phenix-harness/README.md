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

## Base agents

`BASE_AGENTS.md` defines the small reusable role vocabulary used by the workflow set. In the current ACP model a base agent is a `RoleId` contract plus routing policy: the role chooses an appropriate model, while the workflow step supplies the bounded procedure-specific objective.

Keep the role vocabulary broad and reusable. A new engineering procedure should normally compose `scout`, `planner`, `architect`, `implementer`, `tester`, `critic`, `verifier`, `finalizer`, `qa-synthesizer`, and `coordinator` rather than adding one role per workflow.

## Engineering workflows

The core authoring set adapts several procedures from Matt Pocock's MIT-licensed `mattpocock/skills` project to Phenix's explicit session-tree workflow model. The procedures are rewritten as Phenix role graphs rather than copied as agent-skill prompts.

The main idea-to-implementation path is:

```text
workflow.grill-with-docs
        ↓
workflow.spec
        ↓
workflow.tickets
        ↓
workflow.implement
        ↓
workflow.review
```

Additional focused workflows are available for `workflow.tdd`, `workflow.debug`, `workflow.domain-model`, `workflow.architecture`, and `workflow.wayfinder`. Existing Phenix-specific design, migration, QA, refactor, research, security, and UI workflows remain available alongside them.

The important separation is preserved in the graph: implementation is TDD-first; debugging is reproduce/minimize/hypothesize/instrument/fix/regression; and code review keeps engineering-standards review separate from spec-conformance review instead of collapsing them into one verdict.

Upstream inspiration: `https://github.com/mattpocock/skills`.

## Routing format

Routing tables select a complete model configuration for each difficulty:

```text
| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
```

Every D0-D4 cell is:

```text
backend/provider/model/thinking
```

This example keeps the existing role/model choices while making thinking level explicit per difficulty. Those choices are sample user policy, not conductor defaults.

The frontend can be replaced without moving runtime ownership. Other clients may configure the same conductor through the same Phenix ACP API without implementing Lua or sharing this directory layout.
