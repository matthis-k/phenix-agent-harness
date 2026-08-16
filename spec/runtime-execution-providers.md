# Execution provider runtime contract

Status: R12 implementation contract.

Execution providers separate **what a callable means** from **how that callable executes**. They are an execution seam around the Phenix kernel, not an alternate source of identity, lifecycle, policy, routing, or workflow semantics.

## Kernel ownership

The conductor remains authoritative for:

- `SessionId` and `ExecutionId` allocation;
- execution parentage and session lineage;
- callable descriptors and configuration revision;
- invocation policy;
- workflow progression;
- execution lifecycle state;
- canonical execution events;
- model routing for model-backed providers.

An execution provider MUST NOT allocate Phenix IDs, mutate parentage, perform model routing, or bypass the conductor policy engine.

## Callable binding

A registered executable callable has an explicit `ExecutionProviderBinding`:

```text
CallableDescriptor
      +
ExecutionProviderBinding
      |
      +-- Model
      `-- Provider(ExecutionProvider)
```

`register_agent` is the canonical model-backed agent registration path. A provider-backed agent uses an explicit provider binding. There is no bare internal `Agent` implementation marker.

`CallableKind` remains semantic metadata. Runtime dispatch is selected from the provider binding, not inferred from the semantic kind.

## Model provider

The model binding continues through the R10 path:

```text
Execution
  -> provider binding = Model
  -> ResolvedInvocation
  -> PreparedInvocation
  -> backend session
```

Routing is legal only while constructing `ResolvedInvocation`. A non-model provider execution MUST fail model resolution rather than inheriting a model target accidentally.

## Non-model providers

A non-model provider receives an immutable request containing:

- conductor-allocated execution ID;
- session ID;
- parent execution ID;
- callable ID;
- pinned configuration revision;
- invocation objective/input.

The provider can emit normalized reasoning/content through `ExecutionProviderHost`. Those events are appended to the same canonical execution stream used by model backends.

Provider failure is an ordinary execution failure and therefore participates in the same parent/workflow lifecycle propagation.

## Policy ordering

Provider dispatch uses the R11 policy engine:

```text
child exists in Pending
  -> InvocationGuard(DispatchProvider)
  -> provider execute
  -> Running / terminal lifecycle
```

A policy denial occurs before provider code and before provider-emitted events. It does not create a parallel provider-specific permission system.

The callable start/preflight policy remains separate from dispatch policy so policy can independently control whether a child may be created and whether a configured provider may actually execute it.

## Workflow semantics

Workflow definitions validate that each step references an executable binding rather than checking for an internal model-agent implementation.

A workflow therefore creates an ordinary child execution without needing to know whether the child is implemented by:

- a model backend;
- a native provider;
- an ACP provider;
- a remote Phenix provider.

Workflow completion/failure follows ordinary child terminal state propagation.

## Persistence

Executable input is persisted as provider-neutral `invocation` state. Provider bindings and live provider objects are configuration/runtime resources and are not persisted as durable identity.

The R12 checkpoint format is deliberately bumped rather than carrying a compatibility reader for the old `model` payload name. Phenix is prerelease and one canonical representation is preferred.

R13 will replace checkpoint authority with the domain journal; this R12 representation exists so R13 records final provider-neutral execution semantics rather than the previous agent-as-model-marker transition state.

## Cancellation and live scopes

R12 guarantees lifecycle cancellation before dispatch: a cancelled provider child cannot subsequently execute.

Concurrent cancellation of already-running non-model providers is a follow-up to the live-scope abstraction. It MUST use the same process-local ownership model as backend sessions rather than introducing a separate provider cancellation registry. The follow-up is complete only when a blocking mock provider can be cancelled through the ordinary conductor cancellation path and CI proves its live scope is removed on completion, error, cancellation, and unwind paths.

## Automated acceptance boundary

`conductor / execution_provider_runtime` is the R12 system target. It uses a deterministic mock provider and proves:

- provider-backed children are not model-routed;
- exact conductor context reaches the provider;
- provider output becomes canonical execution events;
- workflows are provider-agnostic;
- provider failure propagates through ordinary lifecycle;
- policy executes before provider code;
- cancelled work cannot dispatch.

The R11 `conductor / protocol_e2e` target remains the full serialized frontend-input-to-model-backend boundary. When model-callable delegation/provider invocation is exposed through the conductor callable surface, it SHOULD be added to that E2E fixture rather than creating a second protocol test harness.
