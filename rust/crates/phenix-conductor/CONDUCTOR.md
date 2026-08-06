# Phenix Conductor

The Phenix Conductor is the stateful Phenix ACP proxy, configuration owner, and orchestrator.

- Northbound, it exposes standard ACP plus the typed `_phenix/*` extensions.
- The application layer may submit configuration source descriptors as relative paths or inline strings.
- The conductor resolves those paths, parses all sources, validates the complete graph, constructs the canonical configuration object, and owns that object for the runtime lifetime.
- A frontend may provide Lua, forms, or files as authoring conveniences, but it does not construct `PhenixAcpGateway`, parsed workflow/routing objects, or downstream transports.
- Southbound, the conductor owns one or more ordinary ACP sessions and translates aggregate operations into standard ACP session operations.
- Standard ACP clients address a flattened aggregate root; Phenix-aware clients address the same state through tree and node methods.

```text
application/frontend authoring
        ↓ paths or inline strings
  _phenix/config/* source descriptors
        ↓
Phenix conductor
  resolve → parse → validate → construct → own
        ↓ standard ACP
ordinary downstream ACP agents
```

`_phenix/config/apply` is the canonical configuration boundary. Construction is transactional: the conductor first builds a complete candidate runtime and publishes it only after every source, definition, route, backend, and invariant validates. A failed request leaves the active state unchanged. Configuration is immutable for the lifetime of a running conductor; a different configuration requires a distinct conductor runtime, matching the immutable-per-session-tree policy.

The canonical public API is the ACP wire model. Rust gateway commands, one-shot startup transport, Lua state, and frontend runtime commands are internal implementation details. Language bindings wrap the same source-descriptor and control methods rather than defining alternate configuration objects.
