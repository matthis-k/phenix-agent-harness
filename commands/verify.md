---
description: Verify mechanical checks, plan conformance, and architecture of the current working tree
agent: phenix-verifier
subtask: true
---

Verify the current working tree.

This verification must include:

0. WorkScope conformance:
   - active WorkScope is the single routing/capability model
   - capabilities, invariants, and boundaries are respected
   - git status/diff contain no unrelated or stale changes
   - c1/c2 did not require heavyweight state unless recovery/handoff applied
   - c4 plan conformance and architecture gates are present when required

1. mechanical verification:
   - format
   - lint
   - typecheck
   - tests
   - flake/build checks

2. plan-conformance verification:
   - final diff matches original implementation plan
   - final diff matches planned changes
   - changed files are planned or explicitly justified

3. architecture verification:
   - final diff matches planned architecture contract
   - dependency direction preserved
   - module boundaries preserved
   - docs/tests/config consistent
   - no broad hidden redesign

Fail on unrelated changes, boundary or invariant violations, missing required c4
plan conformance, or unapproved commit/push/publish/deploy/tracked-delete/
secrets/auth/permission-policy actions. Verify evidence, not intent.

Use codebase_memory tools for architecture verification when useful.

Current status:

!`git status --short`

Current diff stat:

!`git diff --stat`

Current diff:

!`git diff`

Workflow state:

Use the `agent_comm` MCP to list/read required request, plan, architecture, implementation, and verification records. Do not fake MCP artifact reads through file paths or shell snippets.

Relevant rules:

@AGENTS.md
@docs/repo-goals.md
@docs/agent-workflow.md
@docs/verification.md
@docs/codebase-memory.md

Return only the structured verifier YAML.
