---
title: routing
type: note
permalink: newxos/routing
---

# Phenix Routing Matrix

The routing matrix in `pi/lib/phenix-routing-matrix.ts` is the single source
of truth for mapping variant × difficulty × costMode to chain name and per-role
model/thinking assignments.

## Variants

| Variant | Description | Models |
|---------|-------------|--------|
| `free` | Free/cheap models only | `opencode/deepseek-v4-flash-free` |
| `opencode-go` | OpenCode Go models | Exact model IDs (deepseek-v4-flash, kimi-k2.7-code, glm-5.1/5.2, etc.) |
| `gpt` | OpenAI GPT models | Capability aliases (fast/thinking/pro) resolved to available models |
| `mixed` | Go for scout/impl, GPT for D2/D3 planner/verifier | Combines Go and GPT |

## Difficulty levels

| Level | Description | Chain | Scout? |
|-------|-------------|-------|--------|
| D0 | Trivial/mechanical | `phenix-d0` | Never |
| D1 | Repo-aware but bounded | `phenix-d1` / `phenix-d1-noscout` | Optional |
| D2 | Architectural/multi-file | `phenix-d2` / `phenix-d2-noscout` | Optional |
| D3 | High-risk/ambiguous | `phenix-d3` | Always |

## Cost modes

| Mode | Description |
|------|-------------|
| `economy` | Avoid GLM-5.2/5.1 and Qwen3.7 Max. Use flash/pro/kimi. |
| `balanced` | D3 GLM-5.2 → GLM-5.1 for non-final roles. |
| `quality` | Use full routing table as-is. |

## Route resolution

```typescript
import { resolveWorkflowRoute } from "../lib/phenix-routing-matrix";

const route = resolveWorkflowRoute({
  variant: "opencode-go",
  difficulty: "D2",
  costMode: "balanced",
  secrecy: "public",
  changeKind: "refactor",
  targetState: "dev-wallet",
});

// route.chain → "phenix-d2" (or "phenix-d2-noscout" if scout is skipped)
// route.roles.implementer → { enabled: true, model: "opencode-go/kimi-k2.7-code", thinking: "medium" }
// route.roles.planner → { enabled: true, model: "opencode-go/glm-5.1", thinking: "high" }
```

## Denial policies

- Free mode denies: `secret`, `private`, `security`, `auth`, `ci`, `permissions`, `deployment`, `main-bound`
- Main-bound target requires at least D1 difficulty

## Adding a model

1. Add the model ID to `OPENCODE_GO_MODELS` or `GPT_CAPABILITY_PREFERENCES`
2. Set the model in the appropriate variant's difficulty table
3. If fallback is needed, ensure the model appears in a preference list

## Chain mapping

The following chain files are available:

| Chain | File | Difficulty | Steps |
|-------|------|------------|-------|
| `phenix-d0` | `phenix-d0.chain.md` | D0 | Worker only |
| `phenix-d1` | `phenix-d1.chain.md` | D1 | Scout → Planner → Worker → Verifier |
| `phenix-d1-noscout` | `phenix-d1-noscout.chain.md` | D1 | Planner → Worker → Verifier |
| `phenix-d2` | `phenix-d2.chain.md` | D2 | Scout → Planner → Critic → Worker → Verifier |
| `phenix-d2-noscout` | `phenix-d2-noscout.chain.md` | D2 | Planner → Critic → Worker → Verifier |
| `phenix-d3` | `phenix-d3.chain.json` | D3 | Scout → Planner → Critic → Worker → Parallel Reviewers → Verifier → Final Review |
| `phenix-repair-loop` | `phenix-repair-loop.chain.json` | Repair | Replan → Re-execute → Re-verify (bounded) |
