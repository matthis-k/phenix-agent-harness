---
description: Review plan or diff against architecture rules
agent: phenix-architect
subtask: true
---

Perform an architecture review.

If plan context is provided, review the plan. If diff context is provided, review the diff.

Run this only when WorkScope routing requires architect: `c4`, repo topology,
public API/config, flake outputs, permission model, agent routing/workflow
semantics, CI/deployment, module ownership boundaries, or a named architecture
ambiguity. Do not require architecture review for cleanup, formatting, or simple
references without those triggers.

Use codebase memory for structural context if relevant.

Current status:

!`git status --short`

Current diff stat (if diff review):

!`git diff --stat`

Rules:

@AGENTS.md
@docs/repo-goals.md
@docs/agent-workflow.md
@docs/verification.md
@docs/codebase-memory.md

Return only the structured architect YAML.
