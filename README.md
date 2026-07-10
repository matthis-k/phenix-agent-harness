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

## Typed handoff system

Phase handoffs use the built-in `phenix_handoff` Pi tool, not MCP. The handoff
system lives entirely in the `phenix-flow` extension:

- **Typed schemas**: TypeBox runtime schemas for 5 handoff kinds (scout-result,
  plan, worker-result, verification-report, repair-result) with TypeScript type
  inference.
- **Immutable artifact store**: File-backed content-addressed storage under
  `.phenix/runs/<run-id>/artifacts/`. Uses SHA-256 digests and atomic writes.
- **Repository manifest**: Deterministic Git-based change detection using
  NUL-delimited diff output. Covers staged, unstaged, untracked, and renamed
  files.
- **Verification validator**: Pure functions that enforce exact file coverage,
  required criteria, manifest freshness, and rejection of blocking findings.
  The verifier's recommendation is never directly trusted.
- **Concise projections**: Role-specific context builders that select only the
  data each phase needs, avoiding generic "all outputs" functions.

`phenix-agent-comm-mcp` remains available for downstream consumers as a general
agent communication MCP server, but is no longer required for workflow handoff.

### Handoff kinds

| Kind | Role | Identity fields |
| ------ | ------ | ---------------- |
| `scout-result` | scout | runId, stepId, effectId, attempt, relevantFiles, editPoints, risks |
| `plan` | planner | runId, stepId, effectId, attempt, objective, steps, acceptanceCriteria |
| `worker-result` | worker | runId, stepId, effectId, attempt, summary, claimedChangedFiles |
| `verification-report` | verifier | runId, stepId, effectId, attempt, manifestDigest, reviewedFiles, criteria |
| `repair-result` | repair | runId, stepId, effectId, attempt, addressedFindings, summary |

Subagents call `phenix_handoff` with a JSON string. The tool validates,
correlates, stores an artifact, and returns acceptance or rejection. Only a
successful handoff advances the workflow.

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
