# Phenix Pi workflow

Use the **`/flow`** command to launch automatic multi-agent workflows:

- **/flow <prompt>** — Classifies, scouts, plans, executes, and verifies through the pipeline.
- **/flow --difficulty <D0|D1|D2|D3> <prompt>** — Override difficulty classification.
- **/flow --scout auto|force|skip <prompt>** — Control repo scout behavior.
- **/flow status** — Show current workflow stage and scout status.
- **/flow cancel** — Cancel active workflow.

## Stage pipeline

**D0 mechanical tasks** (typo, format, obvious rename):
Execute → (optional Verify) → done

**D1+ repo changes** (non-trivial edits, multi-file, config, workflow):
Classify → Scout (real subagent) → Plan → Execute → Verify → Synthesize

If verification fails: Revise → Execute → Verify (up to 3 loops).

## Scouting

For D1+ tasks, a real `repo_scout` subagent runs before the planner. The scout:

- Is a separate model invocation (not a staged turn of the main agent)
- Is read-only: finds files, searches content, reads ranges
- Produces a compact `EvidencePacket` (summary, relevant files, symbols, edit points, risks)
- Returns high/medium/low confidence
- The planner receives and consumes the EvidencePacket rather than exploring the repo from scratch

Use `--scout force` to always run a scout (even for D0).
Use `--scout skip` to skip the scout (even for D1+).

## Model routing

The user selects a `phenix` model variant. The routing matrix resolves:
`<variant>.<role>.<difficulty> → { model, thinking, enabled }`

**OpenCode Go** limits are dollar-value based, so cheap models allow more requests.
DeepSeek V4 Flash and MiMo V2.5 are high-volume cheap routes.
GLM-5.2/5.1 and Qwen3.7 Max are expensive high-reasoning routes.
Kimi K2.7 Code is the preferred code implementation route.

### `phenix/opencode-go` (default)

| Diff | F/E | Scout | Planner | Critic | Implementer | Verifier | Final Rev. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **D0** | `flash` | — | — | — | `flash` (low) | — | — |
| **D1** | `flash` | `flash` (low) | **`qwen3.7-plus`** (med) | — | **`kimi-k2.7-code`** (low) | **`deepseek-v4-pro`** (med) | — |
| **D2** | `flash` | `flash` (med) | **`glm-5.1`** (high) | `deepseek-v4-pro` (med) | `kimi-k2.7-code` (med) | **`glm-5.1`** (high) | — |
| **D3** | `flash` | `deepseek-v4-pro` (high) | **`glm-5.2`** (xhigh) | **`qwen3.7-max`** (high) | `kimi-k2.7-code` (high) | **`glm-5.2`** (xhigh) | **`glm-5.2`** (xhigh) |

*All model IDs use `opencode-go/` prefix. D0 is implementer-only. Planners use progressively stronger models.*

### `phenix/free`

| Diff | F/E | Scout | Planner | Implementer | Verifier |
| --- | --- | --- | --- | --- | --- |
| D0 | `flash-free` | — | — | `flash-free` (low) | — |
| D1 | `flash-free` | `flash-free` (low) | `flash-free` (med) | `flash-free` (low) | `flash-free` (med) |
| D2 | `flash-free` | `flash-free` (med) | `flash-free` (high) | `flash-free` (med) | `flash-free` (high) |
| D3 | `flash-free` | `flash-free` (high) | `flash-free` (xhigh) | `flash-free` (high) | `flash-free` (xhigh) |

### `phenix/gpt`

Uses **ChatGPT Plus-visible GPT models** only. Models resolved via capability aliases.

| Alias | Preference order |
| --- | --- |
| `fast` | `gpt-5.5-instant` → `gpt-5.5` → `gpt-5.5-thinking` |
| `thinking` | `gpt-5.5-thinking` → `gpt-5.5` |
| `pro` | `gpt-5.5-pro` → `gpt-5.5-thinking` → `gpt-5.5` |

If only `openai/gpt-5.5` is available, all aliases resolve to it.
`gpt-5.5-mini` and `gpt-5.6-*` are **never** generated.

| Diff | F/E | Scout | Planner | Implementer | Verifier | Final Rev. |
|---|---|---|---|---|---|---|---|
| D0 | `gpt-5.5` | — | — | `fast` (low) | — | — |
| D1 | `gpt-5.5` | `fast` (low) | `thinking` (med) | `fast` (low) | `thinking` (med) | — |
| D2 | `gpt-5.5` | `fast` (med) | `thinking` (high) | `fast` (med) | `thinking` (high) | — |
| D3 | `gpt-5.5` | `thinking` (high) | `thinking` (high) | `thinking` (high) | `thinking` (high) | `pro` (xhigh) |

### `phenix/mixed`

GPT quota used only for D2/D3 planner/verifier/final-review.
Scouting and implementation use OpenCode Go models.

| Diff | F/E | Scout | Planner | Implementer | Verifier | Final Rev. |
|---|---|---|---|---|---|---|---|
| D0 | `flash` | — | — | `flash` (low) | — | — |
| D1 | `flash` | `flash` (low) | `flash` (med) | `kimi-k2.7-code` (low) | `flash` (med) | — |
| D2 | `flash` | `flash` (med) | **`gpt/thinking`** (high) | `kimi-k2.7-code` (med) | **`gpt/thinking`** (high) | — |
| D3 | `flash` | `flash` (med) | **`gpt/thinking`** (high) | `kimi-k2.7-code` (high) | **`gpt/thinking`** (high) | **`gpt/pro`** (xhigh) |

### Cost modes

| Mode | Behavior |
| --- | --- |
| `quality` | Use the full table as shown above |
| `balanced` | D3: downgrade GLM-5.2 → GLM-5.1 (except final_reviewer) |
| `economy` | Avoid GLM-5.2/5.1 and Qwen3.7 Max; use flash/pro/kimi |

### Fallback resolution

If a configured `opencode-go` model is unavailable:

1. Walk the role's preference list
2. Ultimate fallback: `opencode-go/deepseek-v4-flash`

### Warnings

| Variant | Warning |
|---|---|
| `phenix/free` | Denied for security, auth, ci, deployment. If using "phenix/free", the free model may not be sufficient. |

## Terminology

- **TaskRecord / TaskNode**: State/metadata record only — does NOT execute a subagent
- **SubagentRun**: Actual child agent model execution via `runSubagent()`
- **Scout**: A real read-only repo_scout subagent run that produces EvidencePacket
- **Worker**: Real worker subagent (edit-capable) — planned but not fully implemented in this version

## Known limitations (Pi v0.80.3)

- Pi ExtensionAPI does not expose `spawnAgent`/`createSession` for isolated child agents
- SubagentExecutor spawns a real child pi process (not direct model API calls)
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
  repo topology, public API/config, flake outputs, agent routing,
  CI/deployment, or module ownership boundaries.
- Treat commit, push, publish, deploy, tracked deletion, secrets/auth changes, and
  policy changes as explicit-request-only `c4` work.
- Use Tend for task/profile planning and verification.
- Use Stitch for multi-repository status, DAG, commit, and sync operations.
- Use reversible single-repo Git and safe Nix commands only inside the accepted
  task scope; keep irreversible Git/Nix actions ask/deny by default.
- All subagents use `opencode/deepseek-v4-flash` — no routing abstraction layer.
- Do not manually loop through repositories when Stitch can express the DAG.
- Keep Stitch as orchestrator for multi-repo, DAG-aware, sync, and structural
  commit flows.
- Record command evidence, transport, scope, order, and results.
