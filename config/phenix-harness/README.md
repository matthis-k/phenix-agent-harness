# Phenix Harness example configuration

This directory is an **explicit example and authoring surface**. It is not built-in conductor policy and is not silently selected as a fallback.

A user may copy, reference, or pass this directory explicitly with `--config DIR`. The directory entry point is always `init.lua`.

```text
--config DIR
    │
    ▼
DIR/init.lua
    │
    │ structured Lua authoring
    ▼
typed _phenix/config/apply
    │
    ▼
phenix-conductor
    │
    ▼
immutable configuration revision
```

`init.lua` demonstrates:

- downstream ACP backend registration;
- reusable agent roles;
- Phenix workflow definitions;
- D0-D4 routing/model/thinking policy;
- the same Lua authoring API documented in [`docs/frontend-lua.md`](../../docs/frontend-lua.md).

Lua is only the authoring boundary. The conductor parses, validates, owns, and freezes the resulting configuration. Existing session trees remain pinned to the revision under which they were created.

The example catalog is intentionally not part of the architecture contract. Workflow names, roles, routing tables, and model choices may evolve without becoming conductor defaults.
