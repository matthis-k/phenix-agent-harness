# Phenix Harness example configuration

This directory is an **explicit example/authoring surface**, not built-in conductor policy and not a fallback selected by the packaged application.

A user may copy, reference or pass this directory explicitly with `--config-dir`. If no user configuration is supplied, Phenix does not silently install these workflows, routing tables, roles, backend choices or model choices.

```text
frontend-local Lua and definition files
        ↓ authoring declarations
    typed _phenix/config/apply
        ↓
phenix-conductor
    immutable configuration revision
        ↓
future session trees pin that revision
```

`config.lua` declares reusable Phenix ACP configuration: definitions, router selection, backend registrations and an optional `standard_session` adapter template. Concrete Phenix tree identities are created later through the session-tree API; they are not part of the reusable configuration.

Files below `workflows/` and `routing/` are source documents referenced by this example. Their content becomes authoritative only after a conductor accepts the corresponding configuration request.

## Routing format

Routing tables select a complete model configuration for each difficulty:

```text
| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
```

Every D0-D4 cell is:

```text
backend/provider/model/thinking
```

This example keeps the old role/model choices while making thinking level explicit per difficulty. Those choices are sample user policy, not conductor defaults.

The frontend can be replaced without moving runtime ownership. Other clients may configure the same conductor through the same Phenix ACP API without implementing Lua or sharing this directory layout.
