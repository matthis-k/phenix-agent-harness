<!-- Phenix glossary — available to all agents via opencode config knowledge. -->
# Phenix glossary

## WorkScope terminology

- **WorkScope**: The single semantic model for a request. It carries task class,
  complexity (`c0`..`c4`), risk, capabilities, routing, invariants, boundaries,
  verification expectations, and escalation triggers.
- **c0**: Inspect/read-only work. No tracked-file edits; minimal preflight; no
  heavyweight agent communication MCP unless recovery or handoff is needed.
- **c1**: Trivial mechanical maintenance with obvious intent and tiny blast radius.
  Minimal preflight; no heavyweight agent communication MCP unless recovery or handoff
  is needed.
- **c2**: Localized low-risk edit with clear intent. Route directly to worker when
  capabilities and invariants allow it and no architecture/release/destructive or
  security trigger is present.
- **c3**: Semantic or ambiguous work requiring planner output; architect is
  conditional on a concrete architecture boundary.
- **c4**: High-risk, release/control-plane, workflow/agent routing, permission,
  public API/config, flake output/topology, CI/deployment, module ownership,
  commit/push/publish/deploy, tracked deletion, secrets/auth, or downstream-risk
  work. Requires planner, architect, worker, and strict verifier.
- **Explicit-gated action**: Commit, push, publish, deploy, tracked deletion,
  secrets/auth mutation, and permission weakening. These require explicit user
  approval and c4 handling.

## Phenix commit terminology

When the user asks for a **local commit**, commit only the current node/repository. Do not push. Do not walk the DAG. Do not update downstream flake inputs unless explicitly requested.

When the user asks for a **commit**, commit the current node/repository and push it. This is a single-node operation. Do not walk the DAG and do not update downstream consumers.

When the user asks for a **sync commit**, **commit sync**, **synced commit**, or just **sync** in a commit context, perform the DAG-aware commit operation: compute the affected DAG, walk it dependency-first, update downstream flake inputs where required, commit each affected node, and push each affected node.

Alias rules:

- `commit locally` = `local commit`
- `local commit` = commit current node only, no push
- `commit` = commit current node and push
- `commit and push` = `commit`
- `sync commit` = `synced commit`
- `commit sync` = `synced commit`
- `synced commit` = DAG-aware commit with flake input propagation and push
- `sync` in a commit/finalization context = `synced commit`

If the user's wording is ambiguous, prefer the safest narrower interpretation:
single-node `commit` rather than DAG-wide `synced commit`, unless the user mentions sync, DAG, flake input propagation, downstream consumers, or multiple Phenix nodes.

- **Affected DAG**: The selected nodes plus dependency-graph neighbors that must
  be checked because a change can affect them.
- **Provider**: A lower-layer repo that exports pins, packages, tools, or shared
  contracts consumed by other repos.
- **Consumer**: A higher-layer repo that depends on providers to compose runtime,
  desktop, host, or workspace behavior.
- **Root workspace**: The top-level `phenix` repo that aggregates active
  subflakes and coordinates verification; it is not a child dependency provider.
- **Retired repo**: A former repo or role kept only for historical notes and not
  included in active locked graph inputs, hooks, or normal verification.
- **LocalWorkspaceMode**: A Stitch developer mode that maps locked remote flake
  inputs to local working trees through XDG workspace state. It replaces the old
  submodule-oriented LocalDagMode and does not relax commit/push gates.

## Agent communication

Phenix workflow communication is MCP-only. The `agent_comm` MCP server is the
durable store for sessions, agents, messages, tasks, events, artifacts, and
decisions. OpenCode permissions use the canonical `agent_comm_*` namespace even
when individual MCP tool names use a `comm_` prefix.

## Model config

- **Agent model config**: Static OpenCode `agent.<name>.model` configuration. Phenix does not use a route command, route state file, or Rust routing module.
- **Difficulty class**: Task difficulty used for planner/verifier workflow policy, not runtime model selection. `D0` (trivial/mechanical), `D1` (repo-aware but bounded), `D2` (architectural or multi-file), `D3` (high-risk, ambiguous, cross-module, or main-sensitive).
- **Agent role**: The semantic role an agent performs in the workflow. Roles: `router`, `planner`, `implementer`, `verifier`, `critic`, `final-reviewer`.
- **Configured model**: A concrete OpenCode provider/model string stored in generated config, for example `openai/gpt-5.5`.
- **Secrecy**: The sensitivity classification of a task. Values: `Public`, `Private`, `Secret`.
- **ChangeKind**: The category of change being made. Values: `Docs`, `Nix`, `Rust`, `Qml`, `Workflow`, `RepoArchitecture`, `Secrets`, `Auth`, `Ci`, `Unknown`.
- **TargetState**: The target state for the change. Values: `Scratch`, `DevWallet`, `MainBound`.
- **External plan**: A planner input that is already a usable plan (e.g., written by the user or ChatGPT). The planner detects external plans and normalizes them instead of rewriting from scratch.
- **PlanInputKind**: Classification of user input for external-plan detection. Values: `NotAPlan`, `PartialPlan`, `CompletePlan`.
- **Planner contract**: The normalized plan format that all plans are converted to before implementation. Contains source, intent, scope, non-goals, architecture constraints, steps, validation, stop conditions, and routing metadata.

## Free/Public Model Guardrails

- Free/public-only models must never be used for private, secret, auth, token, SSH, sops, CI secret, deployment, or security-sensitive work.
- D2/D3 main-bound work must have planner + verifier.
- The verifier should be independent in role from the implementer.

## Workflow Policy Defaults

- **D0 public/docs task**: planner may be skipped; verifier may be skipped.
- **D1 Nix/Rust task**: planner normally produces a bounded contract; verifier is optional by risk.
- **D2 architecture task**: planner and verifier are required.
- **D3 high-risk/main-bound task**: planner, verifier, and optional critic/final-reviewer are required by risk.
