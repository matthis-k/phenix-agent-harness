# Phenix runtime architecture

This workspace is intentionally in a purge/rebuild phase.

The architecture has two application boundaries:

```text
frontend <-> Phenix conductor <-> backend adapters <-> providers/agents
```

ACP is not an application layer. `phenix-acp` is restricted to ACP wire/protocol interoperability. It must not own sessions, routing, workflows, callables, tools, persistence, or conductor lifecycle.

`phenix-conductor` is the sole owner of application/runtime semantics. Frontends consume a Phenix-native protocol and project conductor state into their host UI. Backend adapters normalize provider-specific transports into conductor domain events.

The purge commit deliberately removes the previous ACP-shaped application runtime before those semantics are reintroduced on the correct side of the boundary. No compatibility layer is retained.
