---
description: Produce a structured implementation plan
agent: phenix-planner
subtask: true
---

Produce a plan only when the active WorkScope is `c3`/`c4` or a concrete
ambiguity/boundary is named. If the request is clear `c1`/`c2` mechanical
maintenance, return a routing correction to dispatch directly to worker instead
of heavyweight planning.

Use codebase memory for orientation if the task touches multiple modules or files.

Include the WorkScope in the structured YAML and keep it the single source of
truth for capabilities, routing, invariants, boundaries, verification, and
escalation.

Current status:

!`git status --short`

Relevant context:

@AGENTS.md
@docs/repo-goals.md
@docs/agent-workflow.md
@docs/codebase-memory.md

Return only the structured planner YAML.
