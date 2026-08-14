# Phenix Harness example configuration

This directory is an **explicit example and authoring surface**. It is not built-in conductor policy and is not silently selected as a conductor fallback.

A client may evaluate `init.lua` as an authoring file and submit the resulting typed input to `phenix-conductor` through `_phenix/config/load`. The client selects the source root; the conductor resolves, validates, and freezes the resulting revision.

This repository does not package or select frontend configuration. `phenix-nvim` owns its packaged configuration and may instead be configured with `require("phenix").setup({ config_file = ... })`.

```text
init.lua
    │
    │ phenix.acp.* authoring
    ▼
client-selected source descriptors
    │
    │ typed _phenix/config/load
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

Lua is only the authoring boundary. The conductor parses, validates, owns, and freezes the resulting configuration. Existing session trees remain pinned to the revision under which they were created.

The example catalog is intentionally not part of the architecture contract. Workflow names, roles, routing tables, and model choices may evolve without becoming conductor defaults.
