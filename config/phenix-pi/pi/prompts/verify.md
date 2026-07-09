# Phenix Pi verification

Verify the active change against the accepted plan:

1. Inspect the active WorkScope, requested verification profile, and DAG scope.
2. Check git status/diff for unrelated changes, stale refs, boundary overruns, and
   WorkScope invariant violations.
3. Prefer Tend MCP/CLI profile execution over ad-hoc commands.
4. Prefer Stitch MCP/CLI for workspace DAG/status/diff evidence.
5. Confirm changes map to planned change IDs for `c3`/`c4`; for `c1`/`c2`, confirm
   the compact WorkScope/task packet permits the diff without heavyweight state.
6. Fail if commit, push, publish, deploy, tracked deletion, secrets/auth changes,
   or permission weakening occurred without explicit `c4` approval.
7. Report mechanical, WorkScope, plan-conformance, and architecture evidence.
