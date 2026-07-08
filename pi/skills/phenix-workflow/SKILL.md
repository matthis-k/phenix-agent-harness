---
name: phenix-workflow
description: Use when working in the Phenix workspace and the user asks for planning, implementation, verification, commit, sync, Tend, or Stitch workflow help.
---

# Phenix workflow

Follow the Phenix structured workflow:

- Derive one WorkScope for each request: class, complexity (`c0`..`c4`), risk,
  capabilities, routing, invariants, boundaries, verification, and escalation.
- Treat `c0` as inspect/read-only work with no tracked-file edits.
- Treat `c1` as trivial mechanical maintenance with obvious intent and tiny blast
  radius.
- For clear `c1`/`c2` maintenance/change work, do minimal preflight and dispatch
  directly to worker; do not require planner, architect, or heavyweight
  the agent communication MCP unless recovery/handoff is needed.
- Use planner for `c3`/`c4` or named ambiguity. Use architect only for repo
  topology, public API/config, flake outputs, permission model, agent routing,
  CI/deployment, or module ownership boundaries.
- Keep edits inside accepted scope and map each edit to its planned change ID.
- Use Tend for verification profiles and Stitch for DAG-aware multi-repo operations.
- Reversible single-repo Git and safe Nix commands may be used when permitted;
  keep irreversible Git/Nix actions gated by ask/deny behavior.
- Do not commit, push, publish, deploy, delete tracked files, alter secrets/auth, or
  weaken permissions unless explicitly requested and routed as `c4`.
- Keep Stitch as the orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Preserve root as an aggregator; implementation logic belongs in the owning subflake.
- For Pi model routing, use the Phenix provider-first frontend IDs
  `phenix/auto`, `phenix/mixed`, `phenix/openai-plus`, `phenix/opencode-go`, and
  `phenix/free`; inspect routing with `/router status|profile|mode|explain|routes|reload|reset`.
- Keep routing config in `~/.pi/agent/extensions/phenix-router.routes.json` or a
  trusted project `.pi/phenix-router.routes.json`. Do not route through Tend,
  Stitch, MCP servers, credential defaults, or a fake final `setModel` facade.
