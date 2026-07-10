---
title: subagents
type: note
permalink: newxos/subagents
---

# Phenix Subagents (pi-subagents integration)

## Architecture

Phenix uses **pi-subagents** (v0.34.0) as the subagent execution engine for all
child agent workflows. Phenix no longer owns its own child process spawning,
subagent supervision, chain execution, or async job tracking.

```
Phenix custom code:
  - parse /flow flags                                      (phenix-flow/)
  - classify task difficulty/secrecy/change kind            (phenix-routing-matrix.ts)
  - select variant: free | opencode-go | gpt | mixed       (phenix-routing-matrix.ts)
  - select cost mode: economy | balanced | quality          (phenix-routing-matrix.ts)
  - resolve chain + model overrides                         (phenix-routing-matrix.ts)
  - invoke pi-subagents chain                               (phenix-flow/)

Package-backed:
  pi-subagents           — spawn child Pi subagents, run chains/parallel, manage background runs
  pi-mcp-adapter         — compact MCP access without injecting large MCP tool schemas
  pi-lens                — LSP code intelligence replacing custom lsp.ts
  rpiv-ask-user-question — parent-level structured clarification
  rpiv-todo              — parent-visible task state
  pi-hypa                — additive output reduction
  ponytail               — code minimization skill
  rpiv-web-tools         — web search/fetch
```

## Key changes from legacy implementation (retired)

| Area | Before | After |
| ------ | -------- | ------- |
| Subagent execution | Custom `runPhenixSubagent()` in `phenix-subagent-executor.ts` | `pi-subagents` `subagent` tool |
| Chain/workflow engine | Custom state machine in `phenix-flow/` | Declarative chain files + `pi-subagents` chain execution |
| Model routing | Embedded in `phenix-subagent-executor.ts` | Centralized in `pi/lib/phenix-routing-matrix.ts` |
| Agent files | `repo_scout.md`, `planner.md`, etc. | `phenix-scout.md`, `phenix-planner.md`, etc. (with `phenix-` prefix) |
| Parallel execution | Custom `runPhenixSubagentsParallel()` | `pi-subagents` parallel group support |
| LSP tools | Custom `lsp.ts` with per-server spawn | `pi-lens` package |
| Permission gates | None (prompt-level only) | removed |
| MCP access | Direct tool registration | `pi-mcp-adapter` proxy |

## Chain files

Saved workflows live in `config/phenix-pi/pi/chains/`:

| Chain | File | Description |
| ------- | ------ | ------------- |
| `phenix-d0` | `phenix-d0.chain.md` | Minimal mechanical task — single worker |
| `phenix-d1` | `phenix-d1.chain.md` | Bounded workflow: scout → plan → implement → verify |
| `phenix-d1-noscout` | `phenix-d1-noscout.chain.md` | D1 without scouting step |
| `phenix-d2` | `phenix-d2.chain.md` | Architectural: scout → plan → critic → implement → verify |
| `phenix-d2-noscout` | `phenix-d2-noscout.chain.md` | D2 without scouting step |
| `phenix-d3` | `phenix-d3.chain.json` | High-risk: scout → plan → critic → worker → parallel reviewers → verifier → final review |
| `phenix-repair-loop` | `phenix-repair-loop.chain.json` | Repair loop: replan → re-execute → re-verify (bounded) |

## Slash commands

The following pi-subagents slash commands are available:

- `/run <agent> <task>` — Run a single subagent
- `/chain <agent> "task" -> <agent>` — Run agents in sequence
- `/run-chain <name> -- <task>` — Run a saved chain
- `/parallel <agent> "task1" -> <agent> "task2"` — Run tasks in parallel
- `/subagents-doctor` — Subagent diagnostics
- `/subagents-models [agent]` — Show model assignments
- `/subagents-cost` — Show cost breakdown
- `/subagents-profiles` — List saved profiles
- `/subagents-load-profile <name>` — Load a profile

## /flow command

The `/flow` command is now a thin router over saved chains:

```
/flow <prompt>
  -> parse flags (--difficulty, --variant, --cost, etc.)
  -> classify difficulty (phenix-routing-matrix.ts)
  -> resolve WorkflowRoute
  -> if denied: report denial
  -> select chain: phenix-d0/d1/d1-noscout/d2/d2-noscout/d3
  -> invoke selected pi-subagents chain
```

Supported flags:

- `--difficulty D0|D1|D2|D3`
- `--variant free|opencode-go|gpt|mixed`
- `--cost economy|balanced|quality`
- `--target scratch|dev-wallet|main-bound`
- `--scout auto|force|skip`
- `/flow status` — Show active workflow status
- `/flow cancel` — Cancel active workflow
- `/flow doctor` — Run diagnostics

## Agent files

Phenix-specific agents use the `phenix-` prefix:

| Agent file | Role | Tools | Can delegate? |
| ------------ | ------ | ------- | --------------- |
| `phenix-scout.md` | Read-only repo reconnaissance | read, grep, find, ls | No |
| `phenix-planner.md` | Implementation planning | read, grep, find, ls | No |
| `phenix-worker.md` | Scoped implementation | read, grep, find, ls, edit, write, ast_grep, ast_edit, bash | No |
| `phenix-worker-recursive.md` | Delegating implementation | read, grep, find, ls, edit, write, ast_grep, ast_edit, bash, subagent | Yes (depth ≤ 2) |
| `phenix-verifier.md` | Validation and verification | read, grep, find, ls, bash | No |
| `phenix-reviewer.md` | Code review | read, grep, find, ls, bash | No |
| `phenix-debugger.md` | Failure investigation | read, grep, find, ls, bash | No |

## Legacy agents

Legacy agents (`repo_scout.md`, `planner.md`, `worker.md`, `verifier.md`,
`reviewer.md`, `debugger.md`) remain for backward compatibility but are
deprecated. Prefer `phenix-*` agents for new workflows.

## Removed: custom subagent executor

The file `phenix-subagent-executor.ts` has been **removed**. All subagent
execution goes through `pi-subagents`. See `docs/integrations.md` for package
details.

## Package integration

See `docs/integrations.md` for full package inventory, policies, and version pins.
