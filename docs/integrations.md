---
title: integrations
type: note
permalink: newxos/integrations
---

# Phenix Package Integrations

Phenix relies on package-backed integrations for all non-routing functionality.
Custom Phenix code owns only routing, policy, model/profile selection, and thin
`/flow` dispatch.

## Package inventory

| Package | Version | License | Purpose | Shell/Net? | Autonomous? |
|---------|---------|---------|---------|-----------|-------------|
| `pi-context-tools` | 0.1.1 | MIT | Context compaction and info | No | No |
| `pi-subagents` | 0.34.0 | MIT | Subagent spawning, chain execution, parallelism | Spawns child Pi processes | Yes, bounded |
| `pi-mcp-adapter` | 2.11.0 | MIT | MCP proxy and lazy server access | Spawns MCP servers | Lazy lifecycle |
| `pi-lens` | 0.3.0 | MIT | LSP code intelligence (read-only) | Spawns LSP servers | No |
| `@juicesharp/rpiv-ask-user-question` | 0.1.0 | MIT | Parent-level structured clarification | No | No |
| `@juicesharp/rpiv-todo` | 0.1.0 | MIT | Parent-visible task state overlay | No | No |
| `@hypabolic/pi-hypa` | 0.2.0 | MIT | Tool output reduction/compression | No | No |
| `@dietrichgebert/ponytail` | 0.1.0 | MIT | Code-minimization skill | No | No |
| `@juicesharp/rpiv-web-tools` | 0.1.0 | MIT | Provider-backed web search/fetch | Network | Ask-gated |

## Integration architecture

```
Phenix custom code:
  phenix-router.ts          — Provider registration, model cycling
  phenix-routing-matrix.ts  — Variant × difficulty × costMode → chain + model assignments
  phenix-flow.ts            — Thin /flow command: parse flags, classify, resolve route, invoke chain
  phenix-core/              — Shared types and prompt builders

Package-backed:
  pi-subagents              — Real subagent execution via chains
  pi-mcp-adapter            — MCP proxy layer (Tend, Stitch, codebase-memory, GitHub, NixOS, Context7)
  pi-lens                   — LSP code intelligence (diagnostics, hover, definition, references, symbols)
  rpiv-ask-user-question    — Structured clarification at parent level
  rpiv-todo                 — Visible task state
  pi-hypa                   — Additive output reduction
  ponytail                  — Code minimization skill
  rpiv-web-tools            — Web search/fetch (SearXNG, Brave, Tavily, etc.)
```

## Package policies

### pi-subagents
- Default workflow/subagent execution engine.
- Chain files define declarative workflows.
- Recursive worker (`phenix-worker-recursive`) may delegate; max depth 2.
- Scout/planner/verifier/reviewer must NOT delegate.
- Parallel execution via chain parallel groups (D3).

### pi-mcp-adapter
- Default MCP proxy layer.
- Lazy lifecycle by default (servers spawned on demand).
- Proxy mode by default.
- MCP tools not globally visible to child agents.
- Output guards active.

### pi-lens
- Replaces custom lsp.ts as default code intelligence.
- Read-only diagnostics, hover, definition, references, symbols.
- Mutation features (format, autofix, code-action) disabled/ask-gated.
- Background scans disabled by default.

### rpiv-ask-user-question
- Parent-level structured clarification only.
- Used for: ambiguous target state, conflicting strategies, risky mutation approval.
- Child agents use supervisor escalation; parent decides.

### rpiv-todo
- Parent-level visible task state.
- Not a mirror of internal subagent steps.
- Subagent artifacts remain in pi-subagents.

### pi-hypa
- Additive mode (HYPA_PI_MODE=additive).
- MCP proxy in Hypa disabled (HYPA_PI_ENABLE_MCP_PROXY=0).
- Does not replace built-in bash/read/grep/find/ls by default.
- Output caps/recovery documented.

### ponytail
- Skill for code minimization.
- Exposed to planner, reviewer, final reviewer.
- Not injected into worker prompts unless needed.

### rpiv-web-tools
- Default non-Ollama web search/fetch.
- Provider priority: SearXNG > Brave > Tavily > Exa > Jina > Firecrawl > Perplexity > Serper > You.com.
- Web search disabled for private/secret code unless explicitly allowed.
- Worker should not use web search by default.
