# Phenix Runtime R11-R13 Implementation Plan

Status: implementation staging on top of R10.

This plan turns the remaining high-value DeepSeek-harness-derived ideas into concrete Phenix changes without importing an "everything is a plugin" architecture. R10 establishes the immutable invocation/prepared-tool boundary. R11-R13 build on that boundary in dependency order.

The sequence is intentionally destructive where a canonical replacement exists. No compatibility facade, second policy path, or duplicate execution engine should survive a completed stage.

## R11 — typed invocation policy pipeline

### Goal

Move policy decisions out of callable/backend mechanics and into one conductor-owned typed interception seam.

The initial R11 implementation MUST preserve current behavior while changing ownership. In particular, existing `CallablePolicy::requires_permission` behavior is migrated into the policy engine rather than being checked independently by agents, workflows, and tools.

### Canonical model

Use one ordered policy engine with a typed subject rather than unrelated callbacks:

```rust
pub enum InvocationSubject<'a> {
    Callable {
        descriptor: &'a CallableDescriptor,
        operation: CallableOperation,
    },
    Model {
        invocation: &'a PreparedInvocation,
    },
}

pub enum CallableOperation {
    StartAgent,
    StartWorkflow,
    InvokeTool,
}

pub struct InvocationPolicyContext<'a> {
    pub session_id: &'a SessionId,
    pub execution_id: &'a ExecutionId,
    pub config_revision: &'a ConfigRevisionId,
    pub subject: InvocationSubject<'a>,
}

pub trait InvocationGuard: Send + Sync {
    fn check(
        &self,
        context: &InvocationPolicyContext<'_>,
    ) -> Result<(), PolicyDenial>;
}
```

Exact names may change, but the semantics MUST remain:

- the conductor owns the ordered guard registry;
- guards receive typed immutable context;
- a guard can allow or return a structured denial;
- guards cannot directly execute tools, mutate routing, or talk to backends;
- backend adapters never evaluate Phenix policy;
- policy evaluation is deterministic for a pinned configuration revision.

### Required insertion points

R11 MUST route all of these through the same policy engine:

1. agent callable start;
2. workflow callable start;
3. workflow-step callable preflight/start;
4. tool invocation before handler execution;
5. prepared model dispatch before `Backend::open_session`.

There MUST NOT remain direct `requires_permission` checks beside the policy engine after the migration.

### Built-in guards

R11 initially needs only a minimal built-in set:

- `CallablePermissionGuard`: preserves the existing `requires_permission` decision;
- optional capability guard only if it replaces an existing check in the same PR.

Budget/depth/repeat-call guards belong behind the same trait but SHOULD be added only when their semantics are specified and tested. R11 is a seam migration, not a policy feature expansion.

### Error mapping

A policy denial MUST map to the existing normalized `PolicyDenied` frontend error taxonomy. Backends MUST NOT receive or reinterpret the denial.

### Tests

Acceptance requires:

- a custom test guard can deny one prepared model invocation before backend session creation;
- the same guard registry can observe/deny a tool callable invocation;
- existing permission-required agent/workflow/tool behavior remains equivalent;
- no backend is opened after a model-dispatch denial;
- guard order is deterministic;
- policy denial produces no partial tool/backend execution side effect.

## R12 — callable execution providers

### Goal

Separate callable semantics from the mechanism that executes an agent/workflow so Phenix can support local model-backed agents, workflows, ACP-backed children, remote Phenix children, or future execution substrates without adding separate delegation universes.

R12 MUST build on R11 rather than bypassing policy.

### Current limitation to remove

The current registry effectively encodes:

```rust
enum CallableImplementation {
    Tool(...),
    Agent,
    Workflow(...),
}
```

An `Agent` is therefore mostly a marker meaning "create a model execution", and workflows are constrained to agent steps. That is too specialized for backend-neutral delegation.

### Target separation

Keep `CallableDescriptor` semantic. Bind execution separately:

```rust
pub enum CallableImplementation {
    Tool(ToolHandler),
    Executable(ExecutionProviderBinding),
}

pub trait ExecutionProvider: Send + Sync {
    fn kind(&self) -> ExecutionProviderKind;

    fn start(
        &self,
        request: ExecutionProviderRequest,
        host: &mut dyn ExecutionProviderHost,
    ) -> Result<ExecutionProviderResult, ExecutionProviderError>;
}
```

Possible provider kinds include:

```text
Model
Workflow
ACP child runtime
Remote Phenix
Local/native execution
```

The exact enum is not required to be extensible at runtime. Phenix SHOULD prefer a small closed typed kernel over a generic plugin/service-locator system.

### Invocation semantics

The conductor remains authoritative:

```text
CallableId
  -> descriptor/policy lookup
  -> execution provider binding
  -> child ExecutionId allocation
  -> provider execution
  -> canonical events/results
```

Providers MUST NOT allocate Phenix execution identities or own parentage.

### Workflow changes

Workflow steps SHOULD become invocations of executable `CallableId`s rather than being hard-coded to `CallableKind::Agent`.

Required safeguards:

- workflow definitions validate referenced callables;
- recursive workflow cycles are rejected or bounded by explicit policy before execution;
- fixed-target inheritance remains unchanged;
- routed children continue resolving through R10's `ResolvedInvocation` path;
- every provider-created child remains an ordinary Phenix execution node.

### Delegation effect

With R12, delegation becomes execution-provider selection rather than a separate protocol concept:

```text
workflow/agent invokes callable
        |
        v
conductor creates child execution
        |
        v
provider = model | workflow | ACP | remote Phenix | ...
```

ACP is therefore one execution substrate, not the internal delegation model.

### Tests

Acceptance requires:

- existing model-backed agents still execute through the provider abstraction;
- existing workflows still pass with no duplicate legacy path;
- a mock non-model provider can execute a child callable and return canonical events/results;
- workflows can invoke an allowed executable callable without knowing its provider kind;
- provider failure/cancellation maps into the ordinary execution lifecycle;
- R11 policy runs before provider start.

## R13 — journal-authoritative conductor state

### Goal

Make durable domain events the source of truth for reconstructable conductor state. The current checkpoint persists mutable session/execution state and an event history in parallel; R13 removes that dual authority.

This is deliberately later because R10-R12 stabilize what must be recorded.

### Domain journal vs frontend event stream

Do not force every durable domain mutation to be a frontend transcript event. Define a conductor domain journal whose entries are sufficient to replay state, then project frontend `ExecutionEvent`s from it where appropriate.

Conceptually:

```rust
pub struct JournalEntry {
    pub sequence: u64,
    pub event: DomainEvent,
}

pub enum DomainEvent {
    SessionCreated { ... },
    SessionForked { ... },
    SessionRenamed { ... },
    SessionTargetChanged { ... },

    ExecutionCreated { ... },
    ExecutionStateChanged { ... },
    InvocationResolved { ... },

    UserInput { ... },
    AssistantContentDelta { ... },
    ReasoningDelta { ... },
    ToolCallStarted { ... },
    ToolCallArguments { ... },
    ToolCallFinished { ... },
    ChildExecutionStarted { ... },
    ChildExecutionFinished { ... },
    Error { ... },
}
```

Exact variants may differ. The invariant is that replay of the durable journal plus the pinned immutable configuration revision reconstructs all durable Phenix runtime state.

### Command path

Mutations MUST follow one path:

```text
Command
  -> validate against current projection
  -> produce DomainEvent(s)
  -> append atomically
  -> apply reducer/projections
  -> publish frontend events
```

No command may update mutable durable state first and append a best-effort history entry afterward.

### Reducer

State reconstruction MUST use a pure reducer boundary equivalent to:

```rust
fn apply(state: &mut RuntimeState, event: &DomainEvent)
    -> Result<(), ReplayError>;
```

Replay validation MUST reject impossible histories rather than silently repairing them.

### Durable vs ephemeral

Persist/replay:

- session identity/lineage/metadata;
- pinned configuration revision;
- execution identity/parentage/state;
- resolved routing decision where needed for reproducibility/audit;
- user/model/tool semantic events;
- workflow progress represented as domain state/events.

Do NOT persist as domain identity:

- live backend session handles;
- `LiveExecutionScope` resources;
- cancellation channels;
- UI cursor/viewport/fold state;
- process-local listeners/queues.

On restart, durable executions that were active but cannot resume transition explicitly to `Interrupted` according to recovery policy.

### Storage migration

The first R13 implementation MAY retain a snapshot cache for startup speed, but that cache MUST be a derived optimization with a journal sequence/hash anchor. It MUST NOT become a second authoritative mutable representation.

Because Phenix is prerelease, R13 SHOULD replace the existing checkpoint format rather than retaining indefinite compatibility readers. A one-shot development migration tool is acceptable if needed for local test data; it MUST remain outside the runtime API.

### Tests

Acceptance requires:

- construct state by commands, discard in-memory projections, replay journal, and obtain an equal durable snapshot;
- session create/fork/rename/target changes survive replay;
- execution tree and workflow progress survive replay;
- resolved routing decisions are reproducible/auditable without rerouting during replay;
- tool/model event order survives exactly;
- corrupted/out-of-order/impossible histories fail closed;
- live execution scopes never appear in persisted journal data;
- restart recovery marks non-resumable active work explicitly interrupted.

## Dependency order

```text
R10 PreparedInvocation / PreparedToolSurface
        |
        v
R11 typed policy guards
        |
        v
R12 execution providers
        |
        v
R13 journal-authoritative state
```

R11 should be implemented first because both provider dispatch and journal recording need one canonical policy boundary. R12 comes next because R13 should persist the final execution/provider semantics rather than encode the current agent-marker special case. R13 is last because it deliberately rewrites persistence authority.

## Architectural non-goals across R11-R13

These stages MUST NOT introduce:

- a dynamic service locator or Cordis clone;
- arbitrary runtime plugins for core identity/lifecycle semantics;
- model-callable arbitrary conductor RPC;
- ACP-shaped internal domain types;
- separate workflow/delegation/backend execution trees;
- compatibility facades for superseded runtime paths;
- mutable policy/config semantics inside an already pinned session revision.

The intended result is a small rigid Phenix kernel—identity, lifecycle, invocation, policy, journal—with replaceable providers and protocol adapters around it.
