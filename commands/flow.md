---
description: Run adaptive Phenix task-DAG workflow
agent: phenix-workflow
---

Run the adaptive Phenix task-DAG workflow for this request:

$ARGUMENTS

Workflow flags (parsed from `$ARGUMENTS`):
- `--difficulty auto|D0|D1|D2|D3`: Override task difficulty (default: auto).
- `--target-state scratch|dev-wallet|main-bound`: Set the target state (default: dev-wallet).
- `--external-plan auto|force|off`: Control external-plan detection (default: auto).

Model selection is static OpenCode config. There is no route command or Rust
routing state.

1. Save the original request and workflow records through the `agent_comm` MCP when a stateful workflow is needed; do not emulate MCP artifacts with files or shell snippets.
2. Classify task complexity and select the minimum sufficient pipeline:
   - simple_local
   - medium_local_verified
   - dag_verified
   - dag_full_verified
   - full_complete_test
   - dag_commit_sync
3. Discover optional repo contracts if present:
   - `AGENTS.md`
   - `docs/*`
   - `CLAUDE.md` or `.claude/`
   - `knowledge/`
   - `CONTRIBUTING.md`
   - `.opencode/agents/*` (superseded by generated config from agent harness)
4. Do not fail only because these optional files are absent.
5. Build or update the task DAG, task packet, lease, handoff memory, and checkpoint requirements.
6. Invoke only the `phenix-*` agents required by the task DAG.
7. For tracked edits, route writes through `phenix-worker`; workflow must not edit tracked files directly.
8. Prefer tend/stitch MCP tools for structured operations and record `transport: mcp`; use CLI fallback only when MCP is unavailable, insufficient, or raw command output is needed, and record `transport: cli`.
9. Use stitch for cross-repo DAG scope/order and tend for local task/profile semantics. Do not manually loop through repos when stitch can express the operation.
10. For user-facing UI/UX changes, invoke `uiux-designer` before implementation.
11. Verify all tracked edits before completion using the selected verification DAG/profile/scope.
12. On verification failure, require a checkpoint, invoke `failure-analyzer` if useful, and re-run only the required task-DAG path.
13. Do not commit by default. If `$ARGUMENTS` explicitly requests `local commit`, `commit`, `commit and push`, `sync`, `sync commit`, or `synced commit`, treat that as an explicit post-verification commit policy.
14. Run any requested commit policy only after required verifier success and only through `phenix-commit-sync` or an equivalent Stitch-backed route.
15. If the working tree contains pre-existing or user-authored dirty changes
    outside the planned changes ("external changes"), route them through the
    external-change commit-inclusion pipeline (acknowledgement, classification,
    secret review, verifier evidence, commit-summary documentation, Stitch-only)
     after verifier success and before any commit route executes.

!`git status --short`
