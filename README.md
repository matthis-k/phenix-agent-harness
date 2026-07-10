# Phenix agent harness

This flake packages the Phenix OpenCode and Pi agent harness resources.

## Architecture

Phenix custom code owns **only**:

- Routing, policy, model/profile selection (`phenix-router.ts`, `phenix-routing-matrix.ts`)
- Typed statechart workflow engine (`phenix-flow/`)

All other functionality is **package-backed**:

| Package | Purpose |
| --------- | --------- |
| `pi-subagents` | Subagent execution via chains, parallelism, artifacts |
| `pi-mcp-adapter` | MCP proxy layer (Tend, Stitch, codebase-memory, GitHub, NixOS, Context7) |
| `pi-lens` | LSP code intelligence (diagnostics, hover, definition, references, symbols) |
| `pi-context-tools` | Context compaction and info |
| `@juicesharp/rpiv-ask-user-question` | Parent-level structured clarification |
| `@juicesharp/rpiv-todo` | Parent-visible task state |
| `@hypabolic/pi-hypa` | Tool output reduction/compression |
| `@dietrichgebert/ponytail` | Code minimization skill |
| `@juicesharp/rpiv-web-tools` | Provider-backed web search/fetch |

See `docs/integrations.md` for full package inventory, version pins, and policies.

## Key files

- `config/phenix-pi/package.json` — Package manifest with pinned dependencies
- `config/phenix-pi/pi/agents/phenix-*.md` — Phenix-specific agent definitions
- `config/phenix-pi/pi/chains/phenix-d*.chain.*` — Declarative workflow chains
- `config/phenix-pi/pi/lib/phenix-routing-matrix.ts` — Central model routing
- `config/phenix-pi/pi/extensions/phenix-flow/` — Typed statechart workflow engine (reducer + hook adapter)
- `config/phenix-pi/pi/extensions/phenix-router.ts` — Provider registration and model cycling
- `modules/package.nix` — Nix wrapper configuration

## Subagent integration

Phenix uses **pi-subagents** (v0.34.0) as its subagent execution engine.
Child agents, chains, parallel workflows, and background runs all go through
pi-subagents chains. The legacy custom subagent executor (`phenix-subagent-executor.ts`)
has been **removed**.

## Agent communication MCP

`phenix-agent-comm-mcp` is a generic local MCP server for durable agent
communication. It stores sessions, agents, messages, task graphs, events,
artifacts, and decisions in SQLite under the user's XDG data directory.

The Rust core is intentionally policy-free: it records communication and
references/results only. It does not run shell commands, edit source files, or
duplicate Tend/Stitch behavior. Tend remains responsible for verification; Stitch
remains responsible for DAG-aware repository coordination.

Useful debug commands:

```sh
phenix-agent-comm-mcp init
phenix-agent-comm-mcp tool comm_session_init --args '{"name":"example"}'
phenix-agent-comm-mcp stdio-mcp
```

OpenCode is configured with a local `agent_comm` MCP server and canonical
`agent_comm_*` permissions. The MCP tool names themselves currently use the
`comm_` prefix (for example `comm_session_init`, `comm_agent_register`,
`comm_message_send`, `comm_task_create`, `comm_event_recent`,
`comm_artifact_record`, and `comm_decision_record`), but OpenCode permissions
must always use the server namespace. Agents should use MCP records rather than
writing handoff state into the repository.

## Running

```sh
# Build the Phenix Pi wrapper
nix build .#pi

# Check the flake
nix flake check

# Run Pi with Phenix config
nix run .#pi
```

## Workflows

```sh
# Start a workflow (thin /flow command)
/flow --difficulty D1 --variant opencode-go implement the feature

# Status and control
/flow status
/flow cancel
/flow doctor

# Direct chain invocation (pi-subagents)
/run-chain phenix-d1 -- implement the feature
```
