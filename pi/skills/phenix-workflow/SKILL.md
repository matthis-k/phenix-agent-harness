---
name: phenix-workflow
description: Use when working in the Phenix workspace and the user asks for planning, implementation, verification, commit, sync, Tend, or Stitch workflow help.
---

# Phenix workflow

Follow the Phenix structured workflow:

- Plan before editing when the task is not trivial.
- Keep edits inside accepted scope and map each edit to its planned change ID.
- Use Tend for verification profiles and Stitch for DAG-aware multi-repo operations.
- Reversible single-repo Git and safe Nix commands may be used when permitted;
  keep irreversible Git/Nix actions gated by ask/deny behavior.
- Do not commit, push, or sync unless explicitly requested.
- Keep Stitch as the orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Preserve root as an aggregator; implementation logic belongs in the owning subflake.
