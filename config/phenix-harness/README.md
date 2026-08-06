# Phenix Harness frontend configuration

This directory is an **authoring surface for the frontend**, not the canonical runtime configuration store.

The Phenix ACP proxy owns the validated configuration used by routing, workflows, backends, and session-tree creation. A frontend may load Lua and definition files from this directory, but it must translate them into typed `_phenix/config/*` requests and submit them to the proxy. The frontend must not construct `PhenixAcpGateway`, own downstream ACP processes, or treat these files as runtime state.

```text
frontend-local Lua and definition files
        ↓ parse and validate authoring syntax
    typed _phenix/config/* requests
        ↓
Phenix ACP-owned canonical configuration
        ↓ validated runtime projection
routing, workflows, backends, and session trees
```

`config.lua` configures frontend presentation and declares the desired Phenix ACP configuration. Files below `workflows/` and `routing/` are convenient source documents referenced by that declaration. Their content becomes authoritative only after the proxy accepts and stores the corresponding typed configuration revision.

The frontend can therefore be replaced without moving runtime ownership. Other frontends may configure the same proxy through the same API without implementing Lua or sharing this directory layout.

The included definitions are static session-tree projections of the former Pi workflows and the default-difficulty, first-candidate projections of its four model sets. They preserve the legacy IDs and delegated roles, while state-machine-only features such as joins, retries, decisions, difficulty branches, and nested workflow invocation remain outside the current static format.
