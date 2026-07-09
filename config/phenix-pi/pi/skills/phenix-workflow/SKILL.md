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
- Model variants: `phenix/opencode-go` (default), `phenix/free`, `phenix/gpt`, `phenix/mixed`. Routing: `<variant>.<role>.<difficulty> → { model, thinking, enabled }`. D0 is implementer-only. OpenCode Go models use `opencode-go/` prefix format. GPT uses capability aliases (fast/thinking/pro) resolved against available models — no `gpt-5.5-mini` or `gpt-5.6-*` models. Mixed spends GPT quota only on D2/D3 planner/verifier/final-review. Cost modes: quality, balanced, economy. Fallback: role preference lists with ultimate fallback to `opencode-go/deepseek-v4-flash`. `phenix/free` warns about permissions changes.
