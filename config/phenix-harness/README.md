# Phenix Harness example configuration

This directory is an **explicit example/authoring surface**, not built-in conductor policy and not a fallback selected by the packaged application.

A user may copy, reference, or pass this directory explicitly with `--config-dir`. If no user configuration is supplied, Phenix does not silently install these workflows, routing tables, roles, backend choices, or model choices.

```text
Lua authoring policy
        ↓
typed _phenix/config/apply
        ↓
phenix-conductor
    immutable configuration revision
        ↓
future session trees pin that revision
```

`config.lua` is the complete first-class example policy. It defines:

- the downstream ACP backend;
- the shared base-agent role vocabulary;
- the native Phenix workflows;
- Matt Pocock-inspired structural workflows;
- D0-D4 routing tables and model/thinking policy.

There is no separate `legacy` workflow or routing layer in this example.

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

These are shared across the native Phenix workflows and the Matt-inspired procedures. A procedure adds graph structure and a bounded objective; it does not create a new agent taxonomy or encode model names into workflow prose.

The active routing table remains responsible for selecting the concrete backend/provider/model/thinking configuration for each role and difficulty.

## Native Phenix workflows

The native core restores the workflow set used by the earlier Phenix harness:

```text
workflow.implement
workflow.qa
workflow.qa-fix
```

The definitions are rewritten for the current Rust ACP role/tree model rather than carrying forward the retired TypeScript/Markdown runtime implementation.

`workflow.implement` keeps the canonical plan → implement → verify separation.

`workflow.qa` keeps independent repository, test, architecture, and security review branches followed by QA synthesis.

`workflow.qa-fix` extends the same QA structure with a bounded repair plan, implementation, independent verification, and final handoff.

The older workflow engine had richer typed transitions such as a D0 short path, conditional QA repair, joins, and bounded repair loops. The current ACP workflow plan is a static delegated-session tree, so this example does **not** fake those transition semantics in prompt prose. They should return as typed kernel capabilities if and when the current Rust workflow runtime exposes them.

## Difficulty policy

Difficulty is first-class typed runtime data in the current ACP design. A workflow start carries D0-D4, and routing resolves a complete model configuration from:

```text
role × workflow × difficulty
```

Each route selects:

```text
backend/provider/model/thinking
```

The Lua policy defines all D0-D4 cells directly.

QA also restores the earlier policy of using deliberately capable review routes: workflow-specific routing rows pin repository/test review to D2-class model configurations and architecture/security/synthesis to D3-class configurations regardless of the caller's lower requested difficulty. Repair planning and implementation in `workflow.qa-fix` continue to follow the requested workflow difficulty.

Available example routing tables are:

```text
router.mixed
router.opencode-go
router.chatgpt-plus
router.free
```

`router.mixed` is selected by default in this example.

## Matt-inspired structural workflows

The additional workflow set adapts the most reusable structures from `mattpocock/skills` to Phenix's shared base agents:

```text
workflow.grill
workflow.spec
workflow.tickets
workflow.tdd
workflow.debug
workflow.review
workflow.architecture
workflow.domain-model
workflow.wayfinder
workflow.research
```

The important translation rule is that Matt-style procedures contribute **structure**, not a parallel agent system.

Examples:

- `workflow.tdd`: red → green → refactor → verify.
- `workflow.debug`: reproduce → minimize → hypothesize → instrument → fix → regression.
- `workflow.review`: independent standards and spec-conformance reviewers.
- `workflow.spec`: repository context → seams → specification → independent verification.
- `workflow.tickets`: pre-factor analysis → tracer-bullet decomposition → challenge → publish.
- `workflow.wayfinder`: reconnaissance → decision map → high-leverage resolution → frontier verification.

The idea-to-implementation path can therefore be composed conceptually as:

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

Lua is only the authoring surface. The frontend evaluates it and submits definition sources through the typed Phenix ACP configuration request. The conductor constructs and owns the immutable runtime revision. Existing session trees remain pinned to the revision under which they were created.

The frontend can therefore be replaced without moving runtime ownership, and other clients can configure the same conductor through the same Phenix ACP control plane.
