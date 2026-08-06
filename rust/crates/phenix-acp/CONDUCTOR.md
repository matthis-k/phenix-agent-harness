# Phenix Conductor

The Phenix Conductor is the stateful ACP aggregate manager and orchestrator.

- Northbound, it exposes standard ACP plus the typed `_phenix/*` aggregate extensions.
- Southbound, it owns one or more ordinary ACP sessions and translates aggregate operations into standard ACP session operations.
- Its state records the tree, objective, routing, lifecycle, capability, and request correlations required to project those singular sessions as one Phenix aggregate.
- Model-visible delegation remains a tool-level capability; compatible runtimes may later negotiate a narrower optional agent profile for asynchronous peer communication.

The canonical public API is the ACP wire model. Rust gateway commands and frontend runtime commands are internal implementation details.
