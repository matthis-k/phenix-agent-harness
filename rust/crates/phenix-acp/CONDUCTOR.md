# Phenix Conductor

The Phenix Conductor is a policy-neutral, stateful ACP aggregate server.

```text
user / frontend
    |
    | standard ACP + typed _phenix/* requests
    v
phenix-conductor
    |  configuration revisions, tree/node/objective state,
    |  workflow/routing engines, ACP session correlations
    |
    | standard ACP client requests
    v
ACP backend(s)
```

## Boundary

The conductor ships **mechanism, not policy**. It provides the APIs and runtime machinery required to load, validate, store and execute workflows, routing tables, backend definitions, tool policy and related orchestration configuration. It does not install workflows, routers, roles, backend choices, model choices, or model-thinking policy itself.

Concrete configuration is supplied by the user or a higher-level application through the Phenix ACP configuration API. A fresh conductor is therefore unconfigured. Applying configuration creates an immutable revision. Trees created while a revision is active remain bound to that revision even if a later revision is applied for future trees.

Tree/session instance data is separate from reusable configuration. Phenix-native callers explicitly create a tree with its root role, difficulty and objective. The optional `standard_session` configuration is only an adapter template for projecting ordinary ACP `session/new` onto a Phenix tree; it is not conductor policy.

## Protocol ownership

- Northbound, the conductor exposes standard ACP plus typed `_phenix/*` aggregate extensions.
- Southbound, it owns ordinary ACP client sessions and translates aggregate operations into standard ACP session operations.
- Standard ACP remains authoritative for singular-agent execution semantics.
- Phenix owns additional aggregate state: tree and node identity, parentage, objectives, routing/workflow execution, configuration-revision bindings, node-to-session mappings, subtree cancellation and cross-session correlations.
- The canonical public API is the ACP wire model. Rust gateway commands and frontend runtime commands are implementation details.

## Routing

Routing policy is user configuration. A routing rule selects a complete model configuration independently for each difficulty level `D0` through `D4`.

Each difficulty cell is one atomic model configuration:

```text
backend/provider/model/thinking
```

The conductor does not infer or supply any member of that tuple. Difficulty is explicit tree/node runtime state and is inherited by delegated work unless the caller explicitly overrides it.

Model-visible delegation remains a tool-level capability; compatible runtimes may later negotiate a narrower optional agent profile for asynchronous peer communication.
