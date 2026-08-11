# Neovim frontend and Lua authoring

`phenix-nvim` is the interactive Phenix frontend. It uses Neovim's native buffers, windows, editing, navigation, folds, and keymaps and communicates with `phenix-conductor` over ACP stdio.

Lua has two distinct roles:

1. ordinary Neovim/plugin configuration through `require("phenix").setup(...)`;
2. Phenix orchestration **authoring** through `phenix.acp.*` in the selected Phenix configuration file.

Neither role owns conductor runtime state, routing execution, workflows, or downstream ACP sessions.

## Plugin setup

A minimal existing-Neovim setup is:

```lua
require("phenix").setup({})
```

The packaged `phenix` executable already supplies the packaged conductor, `nui.nvim`, plugin runtime path, and example configuration.

Supported setup overrides currently include:

```lua
require("phenix").setup({
  conductor_command = "phenix-conductor",
  config_file = "/path/to/phenix-harness/init.lua",
})
```

Without `config_file`, the plugin checks `PHENIX_CONFIG_DIR/init.lua`, then `$XDG_CONFIG_HOME/phenix-harness/init.lua` (or `~/.config/phenix-harness/init.lua`). A missing configuration is allowed, but `session/new` will only succeed when the conductor has enough configuration to create its standard session projection.

## Commands

```vim
:PhenixOpen [cwd]
:PhenixNew [cwd]
:PhenixPrompt [text]
:PhenixConfig
:PhenixCancel
:PhenixClose
```

`PhenixOpen` creates a Phenix tab containing a transcript and composer. The transcript is a normal Markdown buffer. The composer is a normal editable buffer in a split.

The frontend intentionally does not define a replacement navigation vocabulary. Use normal Neovim motions, scrolling, search, selection, registers, marks, and window commands. Thinking/tool sections are native folds, so ordinary fold commands such as `zo` and `zc` apply.

The only default composer actions are semantic Phenix actions: normal-mode `<CR>` submits and insert-mode `<C-s>` submits. Users may remap these or call the Lua API directly.

## Lua plugin API

```lua
local phenix = require("phenix")

phenix.open({ cwd = vim.fn.getcwd() })
phenix.new({ cwd = "/path/to/repo" })
phenix.prompt("inspect this repository")
phenix.config()
phenix.cancel()
phenix.close()
```

`phenix.current()` returns the current tab's active Phenix session when one exists.

## ACP authoring

The selected Phenix `init.lua` is evaluated in an authoring environment containing `phenix.acp`. It describes the application configuration that the plugin submits through `_phenix/config/apply`.

```lua
phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.mixed",
  standard_session = {
    role = "coordinator",
    difficulty = "d2",
    objective = "Interactive Phenix session tree",
  },
})

phenix.acp.backend({
  id = "pi",
  command = "pi-acp",
})
```

### Workflows

Structured Lua definitions are accepted directly:

```lua
phenix.acp.workflow({
  id = "workflow.implement",
  title = "Implementation",
  steps = {
    {
      key = "plan",
      role = "planner",
      objective = "Plan {objective}",
    },
    {
      key = "implement",
      parent = "plan",
      role = "implementer",
      objective = "Implement {objective}",
    },
  },
})
```

External definition sources may also be referenced:

```lua
phenix.acp.workflow("workflows/custom.md")
phenix.acp.routing_table({ source = source, format = "markdown" })
```

Structured definitions are converted into canonical definition sources and parsed/validated by the conductor-side Phenix domain boundary. Lua does not maintain separate workflow execution semantics.

### Routing tables

Routing tables select a complete `backend/provider/model/thinking` target for each difficulty level:

```lua
phenix.acp.routing_table({
  id = "router.mixed",
  title = "Mixed routing",
  routes = {
    {
      role = "*",
      workflow = "*",
      d0 = "pi/provider/model/minimal",
      d1 = "pi/provider/model/low",
      d2 = "pi/provider/model/medium",
      d3 = "pi/provider/model/high",
      d4 = "pi/provider/model/max",
      explanation = "fallback",
    },
  },
})
```

Difficulty is typed runtime policy, not prompt text. Routing policy belongs to the conductor after configuration is applied.

## Session configuration

ACP session configuration options returned by `session/new` are shown by `:PhenixConfig`. The frontend uses NUI menus for this transient choice surface and submits the selected value through `session/set_config_option`.

Model, mode, thinking-level, and future ACP configuration categories therefore do not require dedicated permanent frontend pages when the ACP option model already represents the interaction.

## UI boundary

There is deliberately no `phenix.keymap`, `phenix.theme`, `phenix.layout`, `phenix.input`, or generic pane API.

Those previous frontend abstractions existed to recreate editor behavior inside Ratatui. In the Neovim frontend they would duplicate native facilities. Configure Neovim directly for presentation and editor behavior; keep `phenix-nvim` APIs semantic and agent-specific.

NUI is currently used for bounded menus/dialogs. It should not grow into a parallel editor, renderer, or authoritative layout model.
