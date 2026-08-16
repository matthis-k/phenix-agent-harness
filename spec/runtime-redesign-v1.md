# Phenix Runtime Redesign v1

Status: proposed normative architecture.

This specification defines the target shape of Phenix when backwards compatibility and migration cost are not constraints. Subsequent implementation PRs MUST conform to these ownership boundaries and invariants. Transitional code may exist only inside explicitly temporary migration PRs and MUST NOT define new public compatibility APIs.

## 1. Goal

Phenix is a persistent agent runtime with multiple interchangeable model backends and multiple interchangeable frontends.

The intended architecture is:

```text
frontend(s)
    |
    | Phenix frontend protocol
    v
phenix-conductor
    |
    | normalized backend interface
    +-- ACP adapter ----> Pi / Codex / other ACP agents
    +-- native adapter -> provider SDK/API
    +-- future adapter -> other execution substrate
```

The conductor is the application. ACP is interoperability infrastructure below the conductor. A frontend is a projection/controller for conductor state.

## 2. Non-goals

The redesign MUST NOT:

- preserve obsolete Phenix APIs for compatibility;
- model Phenix application semantics as ACP extensions;
- make a frontend responsible for routing, workflow execution, tool policy, backend sessions, or persistence;
- make a backend adapter responsible for Phenix sessions, routing, workflow semantics, tool authorization, or callable semantics;
- expose arbitrary conductor RPC as model-callable tools;
- introduce proxy processes without an explicit isolation or protocol requirement;
- retain duplicate old/new APIs during migration.

## 3. Normative ownership

### 3.1 `phenix-conductor`

The conductor MUST be the sole owner of:

- Phenix sessions and session lineage;
- execution trees and execution lifecycle;
- ordered execution events;
- routing profiles and target resolution;
- callable registration and visibility;
- agents and workflows;
- tool descriptors, tool invocation, authorization, and results;
- configuration revisions;
- backend registry and backend-session lifecycle;
- model/backend catalog state;
- authentication state exposed to frontends;
- persistence and recovery.

A frontend MAY request mutations, but it MUST NOT become authoritative for any of the above.

### 3.2 ACP

ACP MUST exist only below the backend boundary.

ACP code MAY own:

- ACP wire types;
- ACP process transport;
- ACP handshake/session translation;
- translation between normalized backend requests/events and ACP requests/notifications;
- ACP-specific authentication and tool-host bridging mechanics.

ACP code MUST NOT own:

- Phenix session IDs;
- routing policy;
- workflow definitions or workflow scheduling;
- conductor configuration state;
- callable visibility/policy;
- tool authorization;
- frontend state;
- Phenix execution-tree semantics.

A future non-ACP backend MUST be implementable without changing conductor or frontend semantics.

### 3.3 Frontends

Frontends MUST own only interaction and presentation concerns, for example:

- rendering;
- local layouts;
- input editing;
- keyboard/mouse interaction;
- frontend-specific buffer/window/widget lifecycle;
- semantic projection of conductor snapshots/events into UI state.

Frontends MUST NOT parse backend protocol messages or depend on ACP concepts.

## 4. Target crate/component shape

Names may change before implementation, but responsibilities MUST remain separated.

```text
phenix-core
  domain IDs and immutable domain values

phenix-protocol
  frontend <-> conductor messages and snapshot/event DTOs

phenix-backend
  normalized backend traits and backend DTOs

phenix-backend-acp
  ACP implementation of phenix-backend

phenix-conductor
  state ownership, execution engine, routing, callables, workflows,
  tool host, policy, persistence, frontend server

phenix-acp (optional)
  low-level ACP wire/translation helpers only; no application runtime
```

`phenix-runtime-api` SHOULD be replaced by the narrower `core`/`protocol`/`backend` boundaries rather than remaining a catch-all API crate.

## 5. Identity and tree model

Three concepts MUST remain distinct.

### 5.1 Session

A `Session` is long-lived user context and is the unit a frontend opens/resumes.

A session owns at least:

- `SessionId`;
- optional parent session for forks;
- display metadata;
- pinned configuration revision;
- default execution target;
- persistent event/history association.

### 5.2 Session lineage

Forking creates user-visible lineage:

```text
session A
├── session B
└── session C
```

Session lineage MUST NOT be represented using backend session IDs.

### 5.3 Execution tree

One submitted objective creates an execution tree:

```text
root execution
└── workflow.implement
    ├── agent.scout
    ├── agent.planner
    ├── agent.worker
    └── agent.verifier
```

`ExecutionId` parentage MUST be independent of session lineage.

Agent and workflow calls MAY create child executions. Tool calls MUST NOT create agent/workflow execution children; they are ordered events within the invoking execution.

Backend session IDs are adapter-private implementation details and MUST NOT become any Phenix identity type.

## 6. Execution target model

The target MUST be a sum type, never multiple optional fields with precedence rules.

```rust
enum ExecutionTarget {
    Fixed(ModelTarget),
    Routed(RoutingProfileId),
}

struct ModelTarget {
    backend: BackendId,
    provider: ProviderId,
    model: ModelId,
    inference: InferenceOptions,
}
```

Required semantics:

- `Fixed` means the concrete target is an execution-tree invariant for all descendant agent/workflow executions unless an explicitly specified future policy says otherwise.
- A child under a fixed root MUST NOT silently re-enter routing.
- `Routed` means the conductor resolves each execution node according to the selected profile and callable context.
- Routing resolution MUST finish before invoking a backend adapter.
- Backend adapters MUST receive a concrete `ModelTarget`, never a routing profile.
- Tool calls do not independently select models.

No separate `routing_enabled`, `selected_model`, or precedence fallback state may coexist with `ExecutionTarget`.

## 7. Callable model

Model-visible operations MUST use one typed catalog abstraction:

```rust
enum CallableKind {
    Tool,
    Agent,
    Workflow,
}

struct CallableDescriptor {
    id: CallableId,
    kind: CallableKind,
    description: String,
    input_schema: JsonSchema,
    output_schema: JsonSchema,
    capabilities: CapabilitySet,
    policy: CallablePolicy,
}
```

Rules:

- schemas MUST be machine-validatable;
- callable visibility MUST be capability/policy filtered by the conductor;
- arbitrary conductor methods MUST NOT be exposed as callables;
- natural language belongs only in explicitly semantic fields such as `objective`, `question`, `summary`, or `rationale`;
- transport/backend mechanics MUST NOT alter callable semantics.

Agents and workflows share discovery/invocation semantics but MAY use different execution engines internally.

## 8. Workflow model

A workflow MUST be a conductor-owned typed execution graph/program, not a special backend session.

A workflow definition MUST declare:

- stable workflow ID;
- typed input/output schemas;
- callable dependencies;
- execution nodes/edges or equivalent typed composition;
- target/routing policy where relevant;
- execution policy such as concurrency or explicit retry behavior.

Workflow execution MUST produce ordinary execution-tree nodes and ordinary ordered events. Frontends MUST NOT require a separate workflow transport or transcript representation.

Cancellation of a workflow execution MUST cascade to active descendants.

The initial implementation SHOULD prefer a small explicit graph/program model over a general embedded scripting engine.

## 9. Canonical event stream

The conductor MUST produce one causally ordered event stream. Ordering MUST be retained exactly as execution occurs.

Minimum event vocabulary:

```text
UserInput
ExecutionStateChanged
AssistantContentDelta
ReasoningDelta
ToolCallStarted
ToolCallArgumentsDelta or complete arguments
ToolCallFinished
ChildExecutionStarted
ChildExecutionFinished
Error
```

Additional semantic events such as images, terminals, usage, or artifacts MAY be added later.

Every event MUST contain:

- monotonically increasing sequence number;
- `SessionId`;
- `ExecutionId`;
- typed event payload.

The stream MUST permit this exact order without regrouping:

```text
reasoning
content
tool call
tool result
reasoning
child execution
content
```

The conductor MUST NOT send frontend line numbers, folds, window instructions, or rendering operations.

A transcript is a projection of semantic events, not the primary persisted representation.

## 10. Runtime state and lifecycle

Execution lifecycle MUST use explicit variants rather than unrelated flags.

Conceptually:

```rust
enum ExecutionState {
    Pending,
    Running,
    Completed,
    Failed(Failure),
    Cancelled,
    Interrupted,
}
```

Impossible combinations SHOULD be unrepresentable. For example, a completed execution MUST NOT simultaneously contain active tool calls in mutable runtime state.

The conductor MUST be event-driven. Busy polling loops are prohibited unless imposed by an external protocol and bounded/backed off. An idle conductor MUST consume negligible CPU.

## 11. Backend interface

A backend implementation is an adapter/factory plus materialized backend sessions.

Conceptually:

```rust
trait Backend {
    fn capabilities(&self) -> BackendCapabilities;
    fn models(&self) -> ...;
    fn authenticate(&mut self, ...) -> ...;
    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError>;
}

trait BackendSession {
    fn execute(
        &mut self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError>;

    fn cancel(&mut self, execution: &ExecutionId) -> Result<(), BackendError>;
}
```

`BackendSessionRequest` MUST contain a concrete model and the conductor-selected tool provision. Backend/provider session identifiers remain private to the adapter.

The conductor MAY cache/reuse backend sessions where supported, keyed by conductor-owned binding state. Reuse MUST NOT change externally visible Phenix semantics.

## 12. Backend capabilities

Backends MUST advertise capabilities explicitly. At minimum:

```text
native tool hosting
MCP stdio tool hosting
ACP-extension tool hosting
unsupported tool hosting
image support
persistent/resumable backend sessions
steering support, if introduced
```

The conductor MUST validate required capabilities before beginning an execution. It MUST fail with a structured pre-execution error instead of partially starting a run that cannot satisfy its tool/capability requirements.

## 13. Tool provisioning and invocation

The conductor owns tool semantics end to end.

At backend-session creation the conductor supplies a `ToolProvision` containing only callables visible to that execution/session under the current policy/configuration revision.

Adapters MAY materialize the provision using native tool APIs, MCP, ACP extensions, or another transport. The chosen mechanism is adapter-local.

When a model requests a tool, the backend session MUST synchronously/asynchronously re-enter a conductor-owned host interface equivalent to:

```rust
trait BackendHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError>;
    fn invoke_tool(&mut self, invocation: ToolInvocation)
        -> Result<ToolResult, BackendError>;
}
```

Before invocation, the conductor MUST validate:

- execution is still live;
- callable exists in the pinned revision;
- callable was provisioned/visible;
- input matches schema;
- policy permits the invocation;
- any required user permission is satisfied.

The conductor MUST emit canonical tool-start/tool-finish events around the invocation.

Adapters MUST NOT directly execute conductor tools or decide Phenix permissions.

Current development policy MAY auto-approve all permitted tools, but permission policy MUST remain a conductor concern so stricter policies can be enabled without adapter changes.

## 14. Routing engine

Routing is a pure conductor concern.

A routing profile MUST resolve from typed context such as:

- callable/role;
- difficulty/effort;
- required capabilities;
- model availability;
- explicit policy constraints.

It MUST return a concrete `ModelTarget` or a typed failure.

The router MUST NOT execute backend protocol operations. The backend adapter MUST NOT know which routing profile selected it.

## 15. Configuration

Configuration is authoring input; the conductor owns the compiled runtime form.

Requirements:

- config loading MUST produce an immutable `ConfigurationRevision`;
- sessions MUST pin a revision;
- reloading configuration MUST create a new revision rather than mutate the meaning of existing sessions/executions;
- frontend code MUST NOT reconstruct workflow/routing semantics from authoring files;
- config parsing and runtime validation belong to conductor-side code/libraries.

A Lua authoring API MAY remain, but Lua MUST compile into ordinary typed domain values. Runtime engines MUST NOT require Lua-shaped state.

The frontend MAY discover/pass an explicit config path when starting/connecting to a conductor. It MUST NOT become the parser or semantic owner.

## 16. Frontend protocol

The frontend protocol is Phenix-owned and MUST NOT be ACP or ACP-plus-extensions.

The protocol MUST support request/reply and unsolicited ordered events.

Conceptually:

```text
ClientMessage::Request { id, command }
ServerMessage::Response { id, result | error }
ServerMessage::Event { sequence, event }
```

Transport framing MAY initially be newline-delimited JSON. Framing is not application semantics and MAY later change without changing commands/events.

Minimum commands:

```text
Initialize / reconnect
GetSnapshot
CreateSession
ForkSession
RenameSession
SetSessionTarget
Submit
CancelExecution
```

The complete product will additionally require typed commands for model/catalog selection, authentication, workflow invocation, steering/follow-up if retained, and configuration reload where supported.

The protocol MUST NOT contain ACP session IDs, ACP method names, frontend line/fold operations, or backend-native event objects.

## 17. Snapshot and resumption

Frontends MUST be disposable and reconstructible.

The conductor MUST expose:

```text
snapshot + ordered events after sequence N
```

A reconnecting frontend MUST be able to obtain a coherent snapshot and continue from an event cursor without reconstructing state from raw backend logs.

Closing Neovim MUST NOT semantically destroy a Phenix session. Process deployment MAY initially provide stdio mode for tests/development, but the target lifecycle is an independently persistent conductor reachable through a local IPC transport (for example a Unix socket/user service).

## 18. Persistence

Persistent state MUST be conductor-owned.

The canonical durable representation SHOULD be an append-only event/history store plus normalized session/configuration metadata. SQLite is an acceptable implementation.

At minimum persist:

- sessions and lineage;
- pinned configuration revision references;
- execution summaries;
- canonical execution events;
- metadata required to resume/reconstruct a frontend snapshot.

Backend process/session handles MUST NOT be persisted as if they were Phenix identities.

After conductor restart:

- reconstructable Phenix state MUST survive;
- resumable backend sessions MAY be reattached;
- non-resumable active executions MUST become explicit `Interrupted`/failed state rather than silently disappear.

## 19. Authentication and model catalog

Authentication is exposed through conductor-owned typed state/actions even when the adapter performs provider-specific mechanics.

The frontend MUST see normalized concepts such as:

```text
backend
provider/model catalog
authentication state
authentication action/flow
```

The frontend MUST NOT run provider login commands because an ACP adapter happened to require them. If an interactive terminal is required, the adapter/conductor describes the action and the frontend merely hosts/presents the interaction.

## 20. Concurrency and cancellation

The conductor MUST own cancellation tokens/lifecycle and propagate cancellation through the execution tree.

Rules:

- cancelling a root cancels active descendants;
- cancelling a child does not imply cancelling unrelated siblings unless workflow policy requires it;
- tool invocations observe execution cancellation;
- adapters receive explicit cancellation for active backend execution where supported;
- late backend events after terminal cancellation/completion MUST be rejected or safely ignored according to sequence/lifecycle rules.

Concurrency SHOULD be explicit in workflow definitions rather than accidental task spawning.

## 21. Error model

Errors crossing architectural boundaries MUST be typed/structured.

At minimum distinguish:

```text
invalid request/config
unknown ID
policy denial
capability mismatch
routing failure
authentication required
backend transport failure
backend protocol failure
tool invocation failure
execution cancelled/interrupted
```

Frontend-visible errors MUST identify the affected session/execution where relevant. Backend-native error payloads MAY be retained as diagnostics but MUST NOT define the public error taxonomy.

## 22. Testing requirements

The architecture MUST be testable without real model providers.

Required layers:

1. pure domain tests for target inheritance, lifecycle, IDs, callable visibility, and workflow planning;
2. reducer/event-order tests;
3. mock-backend integration tests proving `submit -> backend -> content/reasoning/tool -> conductor event stream`;
4. backend capability rejection tests;
5. tool-host tests proving the adapter cannot bypass conductor invocation/policy;
6. frontend-protocol black-box tests against the real conductor server transport;
7. persistence/reconnect tests;
8. ACP-adapter tests isolated below the normalized backend interface.

Tests MUST assert public semantics, not compatibility with deleted APIs.

## 23. Performance invariants

- idle runtime MUST not busy-loop;
- event delivery MUST be push-driven;
- output queues MUST be bounded or have explicit backpressure policy;
- transcript rendering work belongs to frontends, not conductor hot paths;
- backend adapters MUST not require high-frequency polling where callback/streaming mechanisms exist.

## 24. Migration policy

This is prerelease architecture work. Migration uses replacement, not compatibility.

Rules:

- each semantic concept has one canonical API at a time;
- when the replacement is introduced, the obsolete API is deleted in the same PR or the next tightly stacked purge PR;
- no `legacy`, `v1/v2`, fallback, compatibility facade, or dual-path behavior is retained unless required by an external protocol boundary;
- temporary migration code MUST be private and explicitly deleted by a named follow-up PR;
- implementation PRs should be small enough that each merged base remains coherent and testable.

## 25. Required PR sequence

The implementation SHOULD use this order. Exact PR count may change, but architectural dependencies MUST flow in this direction.

### R0 — specifications only

- merge this runtime specification;
- merge frontend conformance specification in `phenix-nvim`;
- no production behavior change.

### R1 — destructive runtime purge

Delete ACP-owned/application-shaped runtime machinery:

- ACP routing/workflow/session-tree/conductor semantics;
- old runtime/backend wrappers that encode those semantics;
- duplicate configuration/tool-host APIs;
- compatibility surfaces.

Leave only enough wire-level ACP code and build structure to support the subsequent adapter rebuild. Regenerate locks/build metadata.

Acceptance: no application semantic type lives under an ACP-owned module/crate.

### R2 — domain + protocol foundations

Add `core`, frontend protocol, and backend boundary types:

- IDs;
- session/execution models;
- `ExecutionTarget`;
- callable descriptors;
- canonical events;
- backend factory/session/host traits;
- structured errors.

No real backend yet.

### R3 — conductor state engine

Add:

- session lineage;
- execution lifecycle/tree;
- event log;
- snapshots;
- cancellation;
- configuration revision pinning;
- mock backend registry/session materialization.

Acceptance: mock backend can execute one prompt and produce ordered content/reasoning events.

### R4 — tool/callable host

Add conductor tool registry, visibility/policy validation, provisioning, tool call events, and backend-host invocation loop.

Acceptance: mock model tool request round-trips through conductor-owned invocation and returns to the mock backend.

### R5 — routing + agents + workflows

Add target resolution, agent callable execution, workflow graph execution, child executions, cancellation propagation.

Acceptance: fixed target inheritance and routed per-node selection are black-box tested.

### R6 — persistence + reconnect

Add persistent session/event store, snapshots/cursors, restart recovery, interrupted execution semantics.

### R7 — ACP backend adapter

Rebuild ACP solely as `phenix-backend` implementation.

Acceptance: conductor can run an ACP backend through the same normalized engine used by the mock backend; no ACP types escape the adapter crate.

### R8 — auth/model catalog

Normalize backend model discovery and auth flows through conductor state/protocol.

### R9 — persistent frontend server lifecycle

Provide local IPC/persistent conductor mode. Retain stdio only as a test/development transport if useful.

## 26. Definition of architectural completion

The redesign is architecturally complete when all are true:

- `phenix.nvim` can be deleted/replaced without changing agent/runtime semantics;
- ACP can be deleted/replaced with a native backend without changing frontend/conductor semantics;
- routing and workflows execute entirely without ACP knowledge;
- model tool calls always return through conductor-owned policy/invocation;
- the transcript is reproduced from conductor snapshots/events;
- session state survives frontend restarts;
- fixed-vs-routed targeting has one typed representation;
- there is no compatibility/legacy runtime path;
- an idle conductor does not consume a CPU core.
