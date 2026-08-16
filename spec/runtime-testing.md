# Runtime testing boundary

Phenix runtime behavior SHOULD be proven at the highest practical boundary with deterministic mocks. Unit tests remain useful for local invariants, but runtime architecture changes are not considered sufficiently covered when they are only exercised by direct method calls.

## Canonical system-test path

The preferred runtime regression path is:

```text
serialized ClientMessage / NDJSON input
        |
        v
ConductorServer + phenix-protocol
        |
        v
ConductorRuntime
        |
        +-- routing / ResolvedInvocation
        +-- tool presentation negotiation / PreparedInvocation
        +-- invocation policy
        +-- live execution scope
        |
        v
scriptable mock Backend + mock model session
        |
        +-- emitted reasoning/content
        +-- conductor-owned tool invocation
        +-- deterministic failure/cancellation
        |
        v
serialized ServerMessage output + final RuntimeSnapshot
```

Tests at this boundary SHOULD assert both sides of the runtime contract:

- frontend-visible replies/events and final execution state;
- the concrete model, prompt, tool presentation, and callable surface received by the backend;
- whether a backend session or tool handler was actually invoked;
- absence of side effects when routing, policy, capability negotiation, or lifecycle validation rejects work.

## Mock backend/model fixture

`tests/support/protocol_harness.rs` provides the reusable runtime fixture. Its model is deliberately scriptable rather than tailored to one feature. Current scripts cover:

- emitting ordered reasoning/content;
- requesting a conductor-provisioned tool and observing its `ToolResult`;
- deterministic backend/model failure.

The fixture records backend opens, executions, cancellations, exact prepared model/tool inputs, prompts, and tool results. Future runtime features SHOULD extend this fixture when possible instead of adding isolated ad-hoc backend mocks.

### Adding a protocol E2E test

The common case SHOULD require no manual server, NDJSON, request-ID, session-ID, writer, or backend-state setup:

```rust
let run = ProtocolHarness::model(MockModelScript::reply("answer"))
    .input("hello")
    .run();

assert_eq!(run.backend.prompts(), vec!["hello"]);
assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
```

Runtime configuration is injected directly into the same fixture:

```rust
let run = ProtocolHarness::model(MockModelScript::tool("echo", "{}", "done"))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(|runtime| {
        runtime.register_tool(tool_descriptor("echo"), echo_handler).unwrap();
    })
    .input("use echo")
    .run();
```

Use `.command(...)`, `.commands(...)`, or `.raw_message(...)` only when a test genuinely needs a non-standard protocol sequence. New backend behavior SHOULD normally be represented by a new `MockModelScript` variant or constructor so tests remain declarative.

A macro is intentionally not the primary API: the builder keeps request flow, runtime configuration, and returned observations explicit enough for compiler errors and failed assertions to remain easy to diagnose.

## Test layers

### Unit

Use in-crate tests for pure/local invariants, for example:

- ordered invocation guards stop at the first denial;
- deterministic tool-presentation preference;
- parsers, reducers, registries, and value-object invariants.

### Integration

Use crate/API integration tests when the contract spans multiple Rust modules but does not require the complete conductor process/protocol boundary.

### System

Use system tests for runtime semantics. `protocol_e2e` is the canonical input-to-backend system target. Architectural work such as policy, execution providers, routing, tool provisioning, lifecycle ownership, cancellation, and recovery SHOULD have coverage here when the behavior is externally observable.

### Product

Product tests remain for installed/package behavior that cannot be represented by deterministic in-process mocks. They should not duplicate ordinary runtime semantics already covered by system tests.

## R11 coverage

The policy pipeline is required to prove:

- normal protocol input reaches the exact prepared mock model and produces protocol events;
- a model-dispatch guard prevents `Backend::open_session` entirely;
- a tool guard prevents the tool handler while allowing the mock model to observe an unsuccessful tool result;
- the built-in `requires_permission` guard preserves agent, workflow-step, and tool behavior after removal of the old direct permission branches;
- deterministic backend failure is normalized through the same protocol/event path.

## Follow-up use

R12 execution-provider tests SHOULD add mock non-model provider scripts to this same runtime boundary and prove provider failure/cancellation plus workflow invocation without provider-kind knowledge.

R13 journal tests SHOULD drive commands through this boundary, restart/replay the durable state, and then continue execution against the same mock backend so replay equivalence is tested as runtime behavior rather than only reducer equality.
