# Phenix Pi workflow

Use this prompt template to run the Phenix WorkScope-driven request → route →
implementation → verification workflow while using Pi.

- Keep root workspace actions orchestration-only.
- Derive one `WorkScope` with class, complexity (`c0`..`c4`), risk,
  capabilities, routing, invariants, boundaries, verification, and escalation.
- Treat `c0` as inspect/read-only work with no tracked-file edits.
- Treat `c1` as trivial mechanical maintenance with obvious intent and tiny blast
  radius.
- Use minimal preflight for `c1`/`c2`; route directly to worker when the request is
  clear, capabilities allow it, and no architecture/release/destructive/security
  trigger is present. Do not require heavyweight agent communication MCP for c1/c2
  unless recovery or handoff needs it.
- Invoke planner only for `c3`/`c4` or a named ambiguity. Invoke architect only for
  repo topology, public API/config, flake outputs, permission model, agent routing,
  CI/deployment, or module ownership boundaries.
- Treat commit, push, publish, deploy, tracked deletion, secrets/auth changes, and
  permission weakening as explicit-request-only `c4` work.
- Use Tend for task/profile planning and verification.
- Use Stitch for multi-repository status, DAG, commit, and sync operations.
- Use reversible single-repo Git and safe Nix commands only inside the accepted
  task scope; keep irreversible Git/Nix actions ask/deny by default.
- Do not manually loop through repositories when Stitch can express the DAG.
- Keep Stitch as orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Record command evidence, transport, scope, order, and results.
