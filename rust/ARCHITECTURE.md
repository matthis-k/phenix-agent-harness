# Phenix runtime architecture

This workspace is intentionally in a purge/rebuild phase.

The architecture has two application boundaries:

```text
frontend <-> Phenix conductor <-> backend adapters <-> providers/agents
```

ACP is not an application layer. `phenix-acp` is restricted to ACP wire/protocol interoperability. It must not own sessions, routing, orchestrations, callables, tools, persistence, or conductor lifecycle.

`phenix-conductor` is the sole owner of application/runtime semantics. Frontends consume a Phenix-native protocol and project conductor state into their host UI. Backend adapters normalize provider-specific transports into conductor domain events.

The purge commit deliberately removes the previous ACP-shaped application runtime before those semantics are reintroduced on the correct side of the boundary. No compatibility layer is retained.

## Definition source boundary

Orchestration authoring formats are source adapters, not additional domain models:

```text
source (Markdown / Lua object / JSON / RON)
    -> parse
OrchestrationDefinition
    -> instantiate
OrchestrationExecution
    -> NodeExecution(...)
```

Every source adapter produces the canonical typed `OrchestrationDefinition` directly. The conductor does not define, compile through, or retain an intermediate `WorkflowDefinition`.

`OrchestrationDefinition` describes coordination between autonomous agent executions. Its `AgentNode`s define assignments and orchestration relationships; an agent remains free to decide how to satisfy its objective within its capabilities and policy. Runtime orchestration owns scheduling, dependency readiness, lifecycle, handoff, cancellation, and eventual graph semantics rather than prescribing an agent's internal procedure.

Orchestration is the canonical current vocabulary across source configuration, callable descriptors, protocol DTOs, execution state, and persistence. New runtime surfaces must not emit a second compatibility vocabulary for the same concept.
