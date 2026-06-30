# Phenix Pi workflow

Use this prompt template to run the Phenix request → plan → architecture review → implementation → verification workflow while using Pi.

- Keep root workspace actions orchestration-only.
- Use Tend for task/profile planning and verification.
- Use Stitch for multi-repository status, DAG, commit, and sync operations.
- Do not manually loop through repositories when Stitch can express the DAG.
- Record command evidence, transport, scope, order, and results.
