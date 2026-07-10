---
title: workflows
type: note
permalink: newxos/workflows
---

# Phenix Workflows

## How workflows work

Phenix workflows use **pi-subagents chains** for multi-step agent execution.
Each workflow is a declarative chain file in `config/phenix-pi/pi/chains/`.

```
User prompt → /flow command
  → parse flags (--difficulty, --variant, --cost, --scout)
  → classify difficulty (D0-D3)
  → resolve routing variant
  → select cost mode
  → select chain (phenix-d0/d1/d1-noscout/d2/d2-noscout/d3)
  → apply model overrides from routing matrix
  → invoke pi-subagents chain
  → chain steps execute as subagent tool calls
```

There is NO custom workflow state machine, NO child process spawning,
and NO custom JSONL parsing. Phenix only routes; pi-subagents executes.

## Workflow selection

| Difficulty | Scout? | Chain | Steps |
|------------|--------|-------|-------|
| D0 | No | `phenix-d0` | Worker only |
| D1 | Yes | `phenix-d1` | Scout → Planner → Worker → Verifier |
| D1 | No | `phenix-d1-noscout` | Planner → Worker → Verifier |
| D2 | Yes | `phenix-d2` | Scout → Planner → Critic → Worker → Verifier |
| D2 | No | `phenix-d2-noscout` | Planner → Critic → Worker → Verifier |
| D3 | Yes | `phenix-d3` | Scout → Planner → Critic → Worker → Parallel Reviewers → Verifier → Final Review |
| Repair | — | `phenix-repair-loop` | Replan → Re-execute → Re-verify (bounded) |

## Running a workflow

```sh
# Via /flow (recommended — uses routing matrix)
/flow --difficulty D1 implement the auth module
/flow --variant mixed --difficulty D2 --cost balanced refactor the routing system
/flow --scout skip --difficulty D2 replace the config parser

# Via /run-chain (direct — uses chain defaults)
/run-chain phenix-d1 -- implement the auth module

# Via /chain (ad hoc)
/chain phenix-scout "Explore the auth flow" -> phenix-planner "Plan the implementation"
```

## Flow flags

| Flag | Values | Description |
|------|--------|-------------|
| `--difficulty` | `D0`, `D1`, `D2`, `D3` | Override difficulty classification |
| `--variant` | `free`, `opencode-go`, `gpt`, `mixed` | Select model variant |
| `--cost` | `economy`, `balanced`, `quality` | Select cost mode |
| `--target` | `scratch`, `dev-wallet`, `main-bound` | Target state for denial policies |
| `--scout` | `auto`, `force`, `skip` | Override scouting decision |

## Status commands

```sh
/flow status    # Show active workflow status
/flow cancel    # Cancel active workflow
/flow doctor    # Run diagnostics
/subagents-doctor  # Detailed pi-subagents diagnostics
```

## Chain files

All chains are declarative. They live in `config/phenix-pi/pi/chains/`:

- `phenix-d0.chain.md`
- `phenix-d1.chain.md`
- `phenix-d1-noscout.chain.md`
- `phenix-d2.chain.md`
- `phenix-d2-noscout.chain.md`
- `phenix-d3.chain.json`
- `phenix-repair-loop.chain.json`

## Agent files

All agents are declarative `.md` files with frontmatter. They live in
`config/phenix-pi/pi/agents/`:

- `phenix-scout.md`
- `phenix-planner.md`
- `phenix-worker.md`
- `phenix-worker-recursive.md`
- `phenix-verifier.md`
- `phenix-reviewer.md`
- `phenix-debugger.md`

Legacy agents remain for backward compatibility but are deprecated.
