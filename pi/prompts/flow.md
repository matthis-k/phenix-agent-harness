# Phenix Pi workflow

Use this prompt template to run the Phenix request → plan → architecture review → implementation → verification workflow while using Pi.

- Keep root workspace actions orchestration-only.
- Use Tend for task/profile planning and verification.
- Use Stitch for multi-repository status, DAG, commit, and sync operations.
- Use reversible single-repo Git and safe Nix commands only inside the accepted
  task scope; keep irreversible Git/Nix actions ask/deny by default.
- Do not manually loop through repositories when Stitch can express the DAG.
- Keep Stitch as orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Record command evidence, transport, scope, order, and results.
