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
  included in active topology, root inputs, hooks, or normal verification.

## Agent communication

Phenix workflow communication is MCP-only. The `agent_comm` MCP server is the
durable store for sessions, agents, messages, tasks, events, artifacts, and
decisions. OpenCode permissions use the canonical `agent_comm_*` namespace even
when individual MCP tool names use a `comm_` prefix.

## Model routing

- **RoutingMode**: The active routing profile that controls which model/provider classes are used for each agent role. Modes: `mixed`, `gpt-only`, `go-only`, `free-only`, `manual`.
- **Difficulty class**: Task difficulty used to select model slots. `D0` (trivial/mechanical), `D1` (repo-aware but bounded), `D2` (architectural or multi-file), `D3` (high-risk, ambiguous, cross-module, or main-sensitive).
- **Agent role**: The semantic role an agent performs in the workflow. Roles: `router`, `planner`, `implementer`, `verifier`, `critic`, `final-reviewer`.
- **ModelSlot**: A semantic capability slot resolved to a concrete provider/model name through user/project configuration. Slots: `planner.strong`, `planner.normal`, `implementer.cheap`, `implementer.normal`, `implementer.strong`, `verifier.cheap`, `verifier.strong`, `free.publicOnly`.
- **ProviderClass**: The model provider class used when resolving model slots. Classes: `GptPlus`, `OpenCodeGo`, `ZenFree`, `Manual`.
- **ModelTier**: The capability tier of a model slot. Tiers: `Free`, `Cheap`, `Normal`, `Strong`.
- **Secrecy**: The sensitivity classification of a task. Values: `Public`, `Private`, `Secret`.
- **ChangeKind**: The category of change being made. Values: `Docs`, `Nix`, `Rust`, `Qml`, `Workflow`, `RepoArchitecture`, `Secrets`, `Auth`, `Ci`, `Unknown`.
- **TargetState**: The target state for the change. Values: `Scratch`, `DevWallet`, `MainBound`.
- **Ctrl+T**: Keyboard shortcut to cycle the active routing mode. Cycles `mixed -> gpt-only -> go-only -> free-only -> manual -> mixed`. Skips `free-only` when the current task is private/secret/security-sensitive.
- **External plan**: A planner input that is already a usable plan (e.g., written by the user or ChatGPT). The planner detects external plans and normalizes them instead of rewriting from scratch.
- **PlanInputKind**: Classification of user input for external-plan detection. Values: `NotAPlan`, `PartialPlan`, `CompletePlan`.
- **Planner contract**: The normalized plan format that all plans are converted to before implementation. Contains source, intent, scope, non-goals, architecture constraints, steps, validation, stop conditions, and routing metadata.

## Free mode guardrails

- Free mode must never be used for private, secret, auth, token, SSH, sops, CI secret, deployment, or security-sensitive work.
- If selected mode is unsafe, skip it and explain the skip in the UI/status message.
- D2/D3 main-bound work must have planner + verifier.
- The verifier should not use the same concrete model as the implementer if avoidable.

## Routing policy defaults

- **D0 public/docs task**: planner may be skipped or use cheap Go; implementer uses Zen free if public; verifier may be skipped.
- **D1 Nix/Rust task**: planner uses GPT Plus normal; implementer uses OpenCode Go normal; verifier uses OpenCode Go different slot.
- **D2 architecture task**: planner uses GPT Plus strong; implementer uses OpenCode Go strong; verifier uses GPT Plus normal/strong.
- **D3 high-risk/main-bound task**: planner uses GPT Plus strong; implementer uses OpenCode Go strong; verifier uses GPT Plus strong; optional critic uses GPT Plus strong.
