# Phenix runtime architecture

Phenix is a persistent agent runtime. The conductor owns application semantics. Frontends and backends are adapters around that runtime.

```text
frontend(s) <-> Phenix conductor <-> backend adapters <-> providers/agents
```

ACP is interoperability below the conductor. `phenix-acp` may own ACP wire types and translation. It does not own Phenix sessions, routing, orchestrations, callables, tools, persistence, workspaces, or lifecycle.

The repository is prerelease. Replace obsolete contracts instead of preserving parallel compatibility APIs.

## Process ownership

One long-lived conductor is shared by all local frontends.

Frontends own interaction state such as active session, layout, scroll position, and draft input. The conductor owns the sessions themselves. A frontend does not lock or own a Phenix session.

Multiple frontends may submit to the same session. The conductor assigns durable ingress order when it accepts a root submission. Root submissions for one session execute in that order. Different sessions may execute concurrently.

Child executions inside one root execution may execute concurrently when their dependencies and workspace authority permit it.

## Session and conversation identity

A `Session` is the long-lived Phenix conversation. Model and backend conversations are implementation details.

Changing a model or routing profile between turns keeps the Phenix conversation. The conductor reconstructs or reuses backend context without making backend session IDs part of Phenix identity.

Session lineage and execution parentage remain separate concepts.

## Workspaces

A workspace is a first-class conductor entity. A session binds to one `WorkspaceId`; forks inherit that workspace. A Git worktree is a distinct workspace even when it shares Git object storage with another worktree.

The real worktree is the source of truth.

Each execution has explicit authority. Authority dimensions are independent:

```text
filesystem: read_only | write
network: none | outbound
repository: read | write
ipc: explicit endpoint set
secrets: explicit grant set
callables: explicit allowed set
```

A child receives at most its parent's authority:

```text
child authority
  = parent delegated authority
  ∩ child configured maximum authority
  ∩ invocation restrictions
```

Runtime approval may authorize an operation within that bound. It does not increase the bound.

Provider credentials are not ambient shell credentials. Execution environments contain only declared non-secret environment, execution-local temporary state, and explicitly granted secrets. Host IPC is denied unless explicitly granted.

Working-tree write authority and Git metadata write authority are separate. A normal implementer may edit files while `.git` remains read-only. Remote Git operations additionally require network and credential authority.

## Read-only execution and scratch data

Read-only agents read the real worktree. Source paths are read-only to the sandbox.

Read-only execution still needs writable temporary state. `/tmp`, execution-local HOME/XDG state, and declared repository scratch paths are writable. Repository scratch is shared by executions in one workspace and is excluded from source consistency tracking.

Projects may mark ignored build/cache paths as Phenix scratch with a namespaced Gitignore directive:

```gitignore
# phenix:scratch
/target/
```

A plain ignored path does not automatically become scratch.

Capturing attempted source writes from a read-only agent is an explicit diagnostic mode. Captured writes form an audit patch and never change the real worktree automatically. The user applies such a patch; a model may assess it only when explicitly asked.

## Workspace consistency

Workspace concurrency follows reader/writer semantics:

- any number of read-only executions may hold read leases;
- exactly one writable execution may hold the write lease;
- a workspace does not run readers and a writer at the same time.

The lease is held for the execution, not one tool call. Orchestrations should therefore consolidate useful read and write phases instead of repeatedly alternating tiny readers and writers.

Executions record file observations for authoritative source files. Observations are file-scoped, not repository-scoped. A changed `src/a.rs` invalidates claims that depended on `src/a.rs`; it does not invalidate unrelated observations of `src/b.rs`.

Native writes carry the expected file version. A stale expected version produces a typed workspace conflict instead of overwriting newer data.

Writable shell commands use a command transaction so modifications can be checked against the relevant pre-command versions before commit. Shell read tracing may remain incomplete until the filesystem runtime can report exact reads; the runtime must not claim a stronger guarantee than it enforces.

External changes are allowed. The conductor detects changed observations and invalidates affected results when needed.

## Write phases and checkpoints

Writable agents modify the real worktree. Their changes are implementation work, including when the attempt later fails. Phenix does not silently roll those changes back.

Before a contiguous write phase, the conductor records a lightweight recovery checkpoint without committing, stashing, resetting, or otherwise changing Git history. The checkpoint distinguishes pre-existing user changes from changes made by the phase.

Authority transitions normally define phase boundaries:

```text
scout/read -> plan/read -> checkpoint -> implement/write -> fixup/write -> test/read
```

An orchestration may request another checkpoint when consecutive writers represent materially different approaches.

Verification applies to the exact source versions it observed. Later changes invalidate only the affected verification dependencies.

## Delegation

Delegation is a directed allow graph over callable IDs. The compiled configuration contains concrete edges.

Typical policy:

```text
root -> any configured callable
implementer -> selected scouts/reviewers/tools
scout -> read-oriented tools and permitted read-only children
```

Tool visibility and delegation policy are separate concerns.

A child uses its own configured maximum authority, further restricted by the parent and invocation. Authority never expands from parent to child. A read-only parent therefore cannot create a writable child.

## Orchestrations

Orchestration authoring formats are source adapters:

```text
source (Markdown / Lua object / JSON / RON)
    -> parse
OrchestrationDefinition
    -> instantiate
OrchestrationExecution
    -> NodeExecution(...)
```

The canonical orchestration runtime is a dependency graph. Sequential execution is one graph shape, not a separate runtime model.

An orchestration has typed input and output schemas. Values inside declared fields may contain prose; the structure is fixed and validated.

Data dependencies are explicit. Node transcripts are not the orchestration data model.

An orchestration may declare an interface agent. The interface agent receives typed orchestration context and outcomes, handles intelligent recovery or final synthesis, and returns data matching the orchestration output schema. It does not hide the orchestration execution tree from frontends or debug tooling.

Without an interface agent, output comes from explicit deterministic bindings and node failure follows deterministic orchestration policy.

## Failure and retry

A child failure is reported to its parent. The parent decides whether to retry, choose another child, continue where permitted, or fail itself. When a parent fails, the conductor cancels active descendants and propagates the failure upward.

The frontend records both the failure and the parent's resulting decision.

A deterministic orchestration has no hidden intelligence. A failed node fails the orchestration to its caller unless its configured interface agent handles the failure.

The first retry creates an `AttemptGroup`. The original failed execution is attempt 1. All attempts in the group share one immutable goal. A materially changed goal is a new invocation, not a retry.

Each failed attempt contributes a short summary:

```text
approach
failure_at
reason
completed_work
```

`failure_at` preserves the fact that work before the failure may still be valid. The next attempt automatically receives the invariant goal and short failure summaries, not every previous transcript. Attempts may use different models or inference settings.

Every retry is a new `ExecutionId`. Attempt identity is separate so frontends may group or expand retries as they choose.

## Routing

Routing is a deterministic conductor policy engine. Backends receive only concrete `ModelTarget` values.

Routing context may include callable, role, difficulty, required capabilities, model availability, and explicit policy constraints. The selected target is captured once for an invocation and is not recomputed by downstream layers.

## Configuration

Configuration compiles to immutable revisions. Sessions pin a revision.

Reload creates a new revision. Existing sessions do not silently change meaning. New sessions use the current revision. An explicit rebase operation may move an existing session to a newer compatible revision. Existing executions keep the revision they started with.

## Persistence and debug export

The target durable store is SQLite in WAL mode. Durable state includes sessions, lineage, configuration revisions, accepted submission order, execution metadata, canonical events, attempt groups, and other conductor-owned state required for recovery.

Live backend handles, cancellation handles, streams, sandboxes, and frontend connections are process-local.

The conductor builds one canonical `SessionDebugBundle` on demand. Serializers encode that bundle; serializers do not independently query runtime state. JSON is the first encoding, not the persistence model.

The debug bundle includes session metadata, conversation, execution tree, attempts, orchestration topology, events, resolved routing, tool activity, failure decisions, workspace authority/observations, and diagnostic read-only patches. Credentials and other secrets are redacted or omitted.

## Implementation order

The runtime migration follows these dependency boundaries:

1. domain contracts for workspace authority, file observations, and retry identity;
2. first-class workspace runtime, reader/writer scheduling, guards, and checkpoints;
3. orchestration DAG, delegation, failure propagation, and retry execution;
4. sandbox enforcement for filesystem, network, IPC, repository metadata, and secrets;
5. SQLite persistence, durable multi-client ingress, configuration rebasing, and debug export.

Each slice must leave one canonical contract. Transitional duplicate APIs must not become public compatibility layers.
