# Phenix Subagents

## What "real subagent" means

A **real subagent** in Phenix is an isolated child `pi` process. This is
fundamentally different from direct model API calls (streamSimple, etc.).

```
Real subagent:
  parent pi process
    └─ spawn child pi process (--mode json -p --no-session)
        └─ child has its own runtime loop
        └─ child has its own active tool set
        └─ child receives a bounded prompt/context pack
        └─ parent receives only compact final output + structured metadata
        └─ parent does NOT ingest the child's full tool transcript

Fake subagent (OLD, replaced):
  parent pi process
    └─ calls streamSimple() directly
        └─ no separate runtime
        └─ full transcript in parent context
        └─ no isolated tool execution
```

## Current status

| Role | Implementation | Status |
|------|----------------|--------|
| `repo_scout` | Child `pi` process via `runPhenixSubagent()` | ✅ Operational |
| `planner` | Staged parent role (may use `runPhenixSubagent()` in future) | 🔶 Staged |
| `worker` | Staged parent role | 🔶 Staged |
| `verifier` | Staged parent role | 🔶 Staged |
| `reviewer` | Staged parent role | 🔶 Staged |
| `debugger` | Available as agent definition, not yet wired | 🔶 Defined |

Phenix currently has a **real child-process `repo_scout` subagent**
and **staged parent-driven planner/worker/verifier phases**.

Do not claim Phenix has a full real multi-subagent planner/worker/verifier
pipeline — only the scout is wired as a real child process. Planner/worker/
verifier may use the `runPhenixSubagent()` primitive in future iterations.

## Architecture

```
phenix-flow
  -> classify request
  -> run real repo_scout child Pi process (via runPhenixSubagent)
  -> planner stage (parent role, may become child in future)
  -> worker stage (parent role, may become child in future)
  -> verifier stage (parent role, may become child in future)
  -> final synthesis
```

### Child process shape

```sh
pi --mode json -p --no-session \
   --model <provider/model> \
   --tools <comma-separated> \
   [--thinking <level>] \
   [--append-system-prompt <agent-file>] \
   "<task prompt>"
```

The child process receives:
- `PI_OFFLINE=1` to skip network startup checks
- `PI_SUBAGENT_DEPTH=<n+1>` for recursion guard
- A resolved model via `--model`
- Role-specific tools via `--tools`
- An optional agent system prompt via `--append-system-prompt`

## Tool policy by role

Tool restrictions are **advisory (prompt-only)**. Pi's extension API does not
enforce tool filtering per-agent turn. The child Pi process receives the agent
markdown which lists available tools, but nothing prevents the child from
calling tools outside the allowlist.

| Role | Default tools | Read-only? |
|------|---------------|------------|
| `scout` | `read,find,search,grep,ls,lsp` | ✅ Yes |
| `planner` | `read,find,search,grep,ls,lsp` | ✅ Yes |
| `architect` | `read,find,search,grep,ls,lsp` | ✅ Yes |
| `worker` | `read,find,search,grep,ls,lsp,edit,ast_grep,ast_edit,bash` | ❌ Can edit |
| `verifier` | `read,find,search,grep,ls,lsp,bash` | ✅ Read-only |
| `reviewer` | `read,find,search,grep,ls,lsp` | ✅ Yes |
| `debugger` | `read,find,search,grep,ls,lsp,bash` | ✅ Read-only |

## Recursion safety

The executor guards against recursive subagent spawning via the
`PI_SUBAGENT_DEPTH` environment variable.

- Current depth limit: `2` (max nesting: parent → subagent → subagent)
- Child agents do NOT receive the `subagent` tool, so they cannot spawn
  further subagents through the tool interface.
- The depth env var is auto-incremented on each child spawn.
- If depth >= `maxDepth`, `runPhenixSubagent()` returns a failed result.

## Agent markdown files

Agent definitions live in:
```text
config/phenix-pi/pi/agents/*.md
```

Each file is markdown with YAML frontmatter:

```markdown
---
name: repo_scout
description: Read-only repository scout
tools: read,find,search,grep,ls,lsp
model: ""
thinking: medium
sessionPreference: ephemeral
---

You are the Phenix repository scout...
```

Available agents:
- `repo_scout.md` — Read-only evidence gathering
- `planner.md` — Task decomposition and planning (staged)
- `worker.md` — Scoped implementation (staged)
- `verifier.md` — Validation and verification (staged)
- `reviewer.md` — Code review (staged)
- `debugger.md` — Failure investigation (staged)

## Public API

### `runPhenixSubagent(input, ctx)`

```typescript
async function runPhenixSubagent(
  input: RunPhenixSubagentInput,
  ctx: ExtensionContext
): Promise<RunPhenixSubagentResult>
```

Input fields:
- `role` — One of `scout`, `planner`, `architect`, `worker`, `verifier`, `reviewer`, `debugger`
- `task` — The task prompt string
- `cwd` — Working directory for the child process
- `model` — Optional model override (e.g., `"opencode/deepseek-v4-flash-free"`)
- `thinking` — Optional thinking level
- `tools` — Optional tool list override
- `maxBytes` — Output byte cap (default: 50KB)
- `maxLines` — Output line cap (default: 2000)
- `timeoutMs` — Process timeout (default: 120s)

Result fields:
- `status` — `"done"` | `"failed"` | `"timeout"` | `"cancelled"`
- `role` — The subagent role
- `modelUsed` — Model string that was actually used
- `summary` — First 200 chars of output or error
- `text` — Final cleaned output text
- `bytes` — Output byte count
- `lines` — Output line count
- `truncated` — Whether output was capped
- `exitCode` — Child process exit code
- `error` — Stderr content if any
- `details` — Additional metadata

### Legacy `runSubagent(request, pi, ctx)`

Maintained for backward compatibility with `phenix-flow.ts`. Delegates to
`runPhenixSubagent()` internally.

## Limitations

1. **Tool enforcement is advisory.** Pi does not enforce per-role tool
   restrictions at runtime. The child agent's prompt lists allowed tools,
   but the child can still call any tool available to `pi`.
2. **No parallel execution.** Each subagent runs serially. Parallel
   execution is planned but not implemented.
3. **No fork mode.** The current implementation uses `--no-session` (spawn
   only). Fork mode (inherit parent context) is not supported.
4. **Agent files must exist on disk.** The executor looks for agent markdown
   files in the configured `PI_CODING_AGENT_DIR/agents/` directory or
   project `.pi/agents/` directory. If not found, it runs without a custom
   system prompt.
5. **Model resolution depends on parent context.** Provider API keys are
   resolved through the parent's `ctx.modelRegistry`. If resolution fails,
   the child process falls back to its own API key discovery.
