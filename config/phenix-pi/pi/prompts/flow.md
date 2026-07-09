# Phenix Pi workflow

Use the **`/flow`** command to launch automatic multi-agent workflows:

- **/flow <prompt>** — Classifies, scouts, plans, executes, and verifies through the pipeline.
- **/flow --difficulty <D0|D1|D2|D3> <prompt>** — Override difficulty classification.
- **/flow --scout auto|force|skip <prompt>** — Control repo scout behavior.
- **/flow status** — Show current workflow stage, model set, and scout status.
- **/flow cancel** — Cancel active workflow.

## Stage pipeline

**D0 mechanical tasks** (typo, format, obvious rename):
🔧 Execute → (optional ✅ Verify) → done

**D1+ repo changes** (non-trivial edits, multi-file, config, workflow):
🔍 Classify → 🔎 Scout (real subagent) → 📋 Plan → 🔧 Execute → ✅ Verify → 📊 Synthesize

If verification fails: 🔄 Revise → 🔧 Execute → ✅ Verify (up to 3 loops).

## Scouting

For D1+ tasks, a real `repo_scout` subagent runs before the planner. The scout:

- Is a separate model invocation (not a staged turn of the main agent)
- Is read-only: finds files, searches content, reads ranges
- Produces a compact `EvidencePacket` (summary, relevant files, symbols, edit points, risks)
- Returns high/medium/low confidence
- The planner receives and consumes the EvidencePacket rather than exploring the repo from scratch

Use `--scout force` to always run a scout (even for D0).
Use `--scout skip` to skip the scout (even for D1+).

## Model sets

The selected Phenix frontend model determines the model set for subagents:

| Frontend | scout model | worker model | verifier model |
|----------|-------------|--------------|----------------|
| `phenix/free` | opencode/deepseek-v4-flash-free | opencode/deepseek-v4-flash-free | opencode/deepseek-v4-flash-free |
| `phenix/mixed` | opencode/deepseek-v4-flash-free | opencode/deepseek-v4-flash-free | openai/gpt-5.5 |
| `phenix/opencode-go` | opencode/deepseek-v4-flash | opencode/deepseek-v4-flash | opencode/deepseek-v4-flash |
| `phenix/gpt` | openai/gpt-5.5 | openai/gpt-5.5 | openai/gpt-5.5 |

## Terminology

- **TaskRecord / TaskNode**: State/metadata record only — does NOT execute a subagent
- **SubagentRun**: Actual child agent model execution via `runSubagent()`
- **Scout**: A real read-only repo_scout subagent run that produces EvidencePacket
- **Worker**: Real worker subagent (edit-capable) — planned but not fully implemented in this version

## Known limitations (Pi v0.80.3)

- Pi ExtensionAPI does not expose `spawnAgent`/`createSession` for isolated child agents
- SubagentExecutor uses direct model invocation via `streamSimple` + `ctx.modelRegistry`
- Tool policy is prompt-only, not runtime-enforced by Pi's tool system
- Multi-turn tool-using subagents (workers with edit tools) are not yet available
- Scout is single-turn model call with rich context (not multi-turn tool loop)

---

# Phenix Pi workflow (advanced)

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
- Prefer Pi's Phenix provider-first frontend IDs when model routing is needed:
  `phenix/auto`, `phenix/mixed`, `phenix/openai-plus`, `phenix/opencode-go`,
  and `phenix/free`. Use `/router status|profile|mode|explain|routes|reload|reset`
  to inspect or adjust routing state.
- Keep route configuration in trusted Pi config (`~/.pi/agent/extensions/phenix-router.routes.json`
  and trusted project `.pi/phenix-router.routes.json`); do not route through Tend,
  Stitch, MCP servers, or credential defaults.
- Do not manually loop through repositories when Stitch can express the DAG.
- Keep Stitch as orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Record command evidence, transport, scope, order, and results.
