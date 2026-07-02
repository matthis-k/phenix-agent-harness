---
description: Verify current diff against the accepted architecture contract
agent: phenix-architecture-verifier
subtask: true
---

Perform a post-implementation architecture verification of the current diff.

Use the original architecture contract, active WorkScope, and planned
architecture patterns. Confirm WorkScope remains the single routing/capability
model; `c1`/`c2` direct routing and `c4` strict routing are preserved; release,
destructive, secrets/auth, and permission-policy actions remain explicit-gated.

Current status:

!`git status --short`

Current diff stat:

!`git diff --stat`

Current diff:

!`git diff`

Workflow state:

Use the `agent_comm` MCP to list/read required architecture contract, planned changes, and implementation summary records. Do not fake MCP artifact reads through file paths or shell snippets.

Rules:

@AGENTS.md
@docs/repo-goals.md
@docs/agent-workflow.md
@docs/verification.md
@docs/codebase-memory.md

Return only the architect YAML with:

```yaml
review_kind: diff
```
