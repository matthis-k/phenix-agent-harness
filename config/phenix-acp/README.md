# Phenix ACP example configuration

This directory is an **explicit example and authoring surface**. It is not built-in conductor policy and is not silently selected as a conductor fallback.

`phenix-nvim` evaluates `init.lua` as an authoring file and submits the resulting typed input to `phenix-conductor` through `_phenix/config/apply`.

Packaged frontends may point directly at this immutable configuration file. Existing Neovim setups can instead configure `require("phenix").setup({ config_file = ... })` or place the file at `$XDG_CONFIG_HOME/phenix-acp/init.lua`.

```text
init.lua
    │
    │ phenix.acp.* authoring
    ▼
phenix-nvim
    │
    │ typed _phenix/config/apply
    ▼
phenix-conductor
    │
    ▼
immutable configuration revision
```

`init.lua` demonstrates downstream ACP backend registration, reusable agent roles, Phenix workflow definitions, and D0-D4 routing/model/thinking policy.

Lua is only the authoring boundary. The conductor parses, validates, owns, and freezes the resulting configuration. Existing session trees remain pinned to the revision under which they were created.

The example catalog is intentionally not part of the architecture contract. Workflow names, roles, routing tables, and model choices may evolve without becoming conductor defaults.
