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
        └─ child receives a bounded prompt/context via stdin or temp file
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
| `planner` | Child `pi` process via `runPhenixSubagent()` | ✅ Operational |
| `worker` | Child `pi` process via `runPhenixSubagent()` | ✅ Operational |
| `verifier` | Child `pi` process via `runPhenixSubagent()` | ✅ Operational |
| `reviewer` | Available as agent definition, not yet wired | 🔶 Defined |
| `debugger` | Available as agent definition, not yet wired | 🔶 Defined |

All wired roles (scout, planner, worker, verifier) run as **real child `pi` processes**.
No role stages use direct model API calls.

### Difficulty-based execution

- **D0** (trivial/mechanical): Parent direct execution. No child subagent spawned.
  The parent agent executes the task directly using available tools.
- **D1+** (all other difficulties): Full subagent workflow with scout, planner,
  worker, and verifier running as child `pi` processes.
- **Classifying** and **synthesizing** remain parent agent turns (not subagent).

### Role-to-agent-file mapping

Agent file names do not always match the role name. The mapping is:

| Role | Agent file |
|------|-----------|
| `scout` | `repo_scout.md` |
| `planner` | `planner.md` |
| `architect` | `planner.md` |
| `worker` | `worker.md` |
| `verifier` | `verifier.md` |
| `reviewer` | `reviewer.md` |
| `debugger` | `debugger.md` |

Role `scout` resolves to `repo_scout.md`, not `scout.md`.

## Architecture

```
phenix-flow
  -> classify request (parent agent turn)
  -> [D0: direct execute (parent agent turn, no child subagent)]
  -> [D1+: scout subagent (child Pi) → planner subagent (child Pi)]
  -> worker subagent (child Pi)
  -> verifier subagent (child Pi)
  -> [pass → synthesizing (parent agent turn)]
  -> [fail → replanner subagent (child Pi with verifier feedback) → worker subagent ...]
  -> final synthesis (parent agent turn)
```

### Child process shape

```sh
pi --mode json -p --no-session \
   --model <provider/model> \
   --tools <comma-separated> \
   [--thinking <level>] \
   [--append-system-prompt <agent-file>] \
   "<task prompt>"  # or stdin/temp file for long prompts
```

The child process receives:
- `PI_OFFLINE=1` to skip network startup checks
- `PI_SUBAGENT_DEPTH=<n+1>` for recursion guard
- `PI_SUBAGENT_COMM_DIR=<dir>` if comm channel is active (set by flow)
- `PI_SUBAGENT_RUN_ID=<id>` if comm channel is active
- `PI_SUBAGENT_ROLE=<role>` if comm channel is active
- A resolved model via `--model`
- Role-specific tools via `--tools`
- An optional agent system prompt via `--append-system-prompt`

### Prompt transport

Long prompts (over 8KB) are passed via **stdin** or **temp file**, NOT as argv.
Short prompts under 8KB may use argv as a fallback. If neither stdin nor temp
file transport is available and the prompt exceeds 8KB, the subagent fails
explicitly with a clear error message.

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
- `planner.md` — Task decomposition and planning
- `worker.md` — Scoped implementation
- `verifier.md` — Validation and verification
- `reviewer.md` — Code review (staged, not wired)
- `debugger.md` — Failure investigation (staged, not wired)

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
- `task` — The task prompt string (passed via stdin/temp-file, not argv for long prompts)
- `cwd` — Working directory for the child process
- `model` — Optional model override (e.g., `"opencode/deepseek-v4-flash-free"`)
- `thinking` — Optional thinking level
- `tools` — Optional tool list override
- `maxBytes` — Output byte cap (default: 50KB)
- `maxLines` — Output line cap (default: 2000)
- `timeoutMs` — Process timeout (default: 120s)
- `commDir` — Comm channel directory (passed to child via env)
- `runId` — Run identifier (passed to child via env)

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
- `details` — Additional metadata (includes promptTransport)

### `buildChildEnv(input, ctx)`

Helper for testing/verification — constructs the child process environment
map without actually spawning a process.

### Legacy `runSubagent(request, pi, ctx)`

Maintained for backward compatibility with `phenix-flow.ts`. Delegates to
`runPhenixSubagent()` internally.

## Subagent comm channel

The executor provides a file-based IPC mechanism for inter-subagent
communication:

- `ensureCommChannelDir()` — Create shared comm directory
- `writeCommMessage()` / `readCommMessage()` / `listCommMessages()` — Message I/O
- `writeSubagentResult()` / `readSubagentResult()` — Result persistence
- `waitForCommMessage()` — Poll for matching messages

Child processes receive `PI_SUBAGENT_COMM_DIR`, `PI_SUBAGENT_RUN_ID`, and
`PI_SUBAGENT_ROLE` in their environment when the comm channel is active.
However, children only use the channel if agent/tooling explicitly writes to it.

## Limitations

1. **Tool enforcement is advisory.** Pi does not enforce per-role tool
   restrictions at runtime. The child agent's prompt lists allowed tools,
   but the child can still call any tool available to `pi`.
2. **Subprocess isolation exists** — each child is a separate OS process
   with its own runtime, but tool restrictions are prompt-only.
3. **No fork mode.** The current implementation uses `--no-session` (spawn
   only). Fork mode (inherit parent context) is not supported.
4. **Agent files must exist on disk.** The executor looks for agent markdown
   files in the configured `PI_CODING_AGENT_DIR/agents/` directory or
   project `.pi/agents/` directory. Uses the `AGENT_FILE_BY_ROLE` map to
   resolve role to file name (scout -> repo_scout.md).
5. **Model resolution depends on parent context.** Provider API keys are
   resolved through the parent's `ctx.modelRegistry`. If resolution fails,
   the child process falls back to its own API key discovery.
6. **Prompt transport for long prompts** uses stdin or temp file, not argv.
   No hidden global `pi install` state is required.
7. **No runtime enforcement** — tool filtering is prompt-level only.
8. **Parallel execution** is supported (`runPhenixSubagentsParallel`),
   but the flow pipeline runs subagents serially.
