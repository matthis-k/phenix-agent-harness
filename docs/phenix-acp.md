# Phenix ACP architecture

Phenix extends Agent Client Protocol (ACP) with aggregate state and operations that do not belong to one agent session. The conductor is the server for that protocol and is itself an ACP client of ordinary downstream agents.

```text
user configuration / frontend
            |
            | standard ACP + typed _phenix/*
            v
      phenix-conductor
      Phenix ACP server
      - configuration revisions
      - session trees / objectives
      - routing / workflow engines
      - node <-> ACP session state
            |
            | standard ACP client
            v
   Pi ACP / Codex / other ACP agents
```

A Phenix tree is not one ACP session. Each live Phenix node owns one downstream standard ACP session. The conductor virtualizes those singular sessions into one aggregate northbound endpoint.

## Mechanism versus policy

`phenix-conductor` is a framework. It ships the machinery to load, validate, store and execute routing tables, workflows, backend definitions and tool policy, but it does not install any of those policies itself. A fresh conductor is unconfigured.

Concrete workflows, routers, roles, backend choices, models and thinking levels come from the user or a higher-level application through `_phenix/config/*`. Repository sample definitions and smoke fixtures are explicit opt-in authoring/test data; they are not conductor defaults.

## Configuration revisions and tree instances

Applying configuration creates an immutable revision. A later apply creates a new revision and makes it active for future trees. Existing trees remain bound to their original revision, so routing or workflow policy cannot change under a running tree.

Reusable configuration contains definitions, routing, backends and tool policy. Concrete tree instance data does not: root role, difficulty, objective and optional requested tree identity belong to `_phenix/session_tree/create`.

The optional `standard_session` configuration is only an adapter template for clients that use ordinary ACP `session/new`; Phenix-native clients should create trees explicitly.

## Difficulty-aware routing

A router row has one complete model configuration for each difficulty level:

```text
| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
```

Each D0-D4 cell is atomic:

```text
backend/provider/model/thinking
```

For example:

```text
pi/openai-codex/gpt-5.6-terra/high
```

The conductor does not infer omitted members of that tuple. Difficulty is explicit runtime state. Delegated work inherits its parent/tree difficulty unless the operation explicitly supplies another difficulty.

## Crate responsibilities

- `phenix-acp`: canonical Phenix wire types, configuration/source parsing, tree/routing/workflow abstractions and aggregate runtime primitives.
- `phenix-conductor`: Phenix ACP server and authoritative aggregate/configuration state owner.
- `phenix-acp-backend`: ordinary ACP client transport/adaptation. It does not own frontend orchestration or hard-code Phenix roles.
- `phenix-runtime-api`: typed frontend/backend runtime projection API.
- `phenix-tui`: UX, Lua authoring integration and rendering. It configures the conductor through Phenix ACP rather than constructing gateway state.
- `phenix-acp-presets`: explicit fixture/example package used by smoke verification, never imported by the conductor as policy.

## Standard ACP versus Phenix extensions

Standard ACP remains authoritative for singular-agent behavior: initialization, authentication, session lifecycle, prompting/cancellation, images, tools, permissions, terminals and model/session configuration.

Phenix extensions cover aggregate concepts such as configuration revisions, session trees, recursive workflow execution, difficulty-aware routing, objectives, node operations and subscriptions.

There is one downstream protocol: ACP. Supporting another agent means configuring another ACP backend, not adding a parallel frontend transport.

## Verification

The canonical validation path remains:

```text
cargo fmt --all --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
nix flake check --print-build-logs --keep-going
```

Credential-free fixtures exercise the conductor-to-ACP boundary without requiring production credentials.
