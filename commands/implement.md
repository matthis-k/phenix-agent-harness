---
description: Implement the accepted plan
agent: phenix-worker
subtask: true
---

Implement the changes described by the active WorkScope and, when present, the
accepted plan/architecture contract.

Follow the planned change IDs exactly for `c3`/`c4`. For direct `c1`/`c2`, stay
inside the compact WorkScope, capability gates, invariants, and boundaries. Do
not broaden scope.

Do not commit, push, publish, deploy, delete tracked files, alter secrets/auth, or
weaken permissions unless explicitly requested and allowed by the active
WorkScope.

Current status:

!`git status --short`

Plan reference:

@AGENTS.md
@docs/agent-workflow.md

Return only the structured implementer YAML.
