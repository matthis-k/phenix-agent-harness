---
name: phenix-workflow
description: Use when working in the Phenix workspace and the user asks for planning, implementation, verification, commit, sync, Tend, or Stitch workflow help.
---

# Phenix workflow

Follow the Phenix structured workflow:

- Plan before editing when the task is not trivial.
- Keep edits inside accepted scope and map each edit to its planned change ID.
- Use Tend for verification profiles and Stitch for DAG-aware multi-repo operations.
- Do not commit, push, or sync unless explicitly requested.
- Preserve root as an aggregator; implementation logic belongs in the owning subflake.
