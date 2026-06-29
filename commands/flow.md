---
description: Run full Phenix plan -> architecture -> implementation -> verification workflow
agent: workflow
---

Run the Phenix workflow for this request:

$ARGUMENTS

1. Save the original request to `.opencodestate/request.md` when a stateful workflow is needed.
2. Classify workflow depth:
   - read-only
   - trivial edit
   - standard edit
   - full workflow
3. Discover optional repo contracts if present:
   - `AGENTS.md`
   - `docs/*`
   - `CLAUDE.md` or `.claude/`
   - `knowledge/`
   - `CONTRIBUTING.md`
   - `.opencode/agents/*`
4. Do not fail only because these optional files are absent.
5. Invoke only the agents required by the routing predicates in `workflow.md`.
6. For tracked edits, route writes through `implementer`; workflow must not edit tracked files directly.
7. For user-facing UI/UX changes, invoke `uiux-designer` before implementation.
8. Verify all tracked edits before completion.
9. On verification failure, invoke `failure-analyzer` and re-run only the required planning/architecture/implementation path.
10. Do not commit by default. If `$ARGUMENTS` explicitly requests `local commit`, `commit`, `commit and push`, `sync`, `sync commit`, or `synced commit`, treat that as an explicit post-verification commit policy.
11. Run any requested commit policy only after verifier success across mechanical, plan-conformance, and architecture checks, and only through Stitch-safe routes or delegated `review-committer` review.
12. If the working tree contains pre-existing or user-authored dirty changes
    outside the planned changes ("external changes"), route them through the
    external-change commit-inclusion pipeline (acknowledgement, classification,
    secret review, verifier evidence, commit-summary documentation, Stitch-only)
    after verifier success and before any commit route executes.

!`git status --short`
