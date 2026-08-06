# Phenix Harness frontend configuration

This directory is an example user configuration for the native Phenix frontend. Install or link it at:

```text
$XDG_CONFIG_HOME/phenix-harness/
```

The frontend reads `config.lua`. Lua configures both UI behavior and the ACP session-tree runtime. Referenced workflow and routing files are resolved relative to this directory and passed as source text to `phenix-acp`.

The included definitions are static session-tree projections of the former Pi workflows and the default-difficulty, first-candidate projections of its four model sets. They preserve the legacy IDs and delegated roles, while state-machine-only features such as joins, retries, decisions, difficulty branches, and nested workflow invocation remain outside the current static format.
