# Neovim frontend and Lua authoring

`phenix-nvim` is a minimal Neovim frontend for `phenix-conductor`. It uses ordinary Neovim buffers and windows and communicates with the conductor over ACP stdio.

Lua has two distinct roles:

1. ordinary Neovim/plugin configuration through `require("phenix").setup(...)`;
2. Phenix orchestration authoring through `phenix.acp.*` in the selected Phenix configuration file.

Neither role owns conductor runtime state, routing execution, workflows, or downstream ACP sessions.

## Plugin setup

The minimal setup is:

```lua
require("phenix").setup()
```

By default, `<leader>pp` toggles the Phenix sidebar. The sidebar is a right-hand vertical split with a transcript buffer on top and an input buffer below it.

The input buffer is intentionally simple: type one prompt and press `<CR>` to send it, or use `:write`. While that prompt is running, another prompt is rejected. Follow-up and steering interaction is not implemented yet.

Supported setup overrides include:

```lua
require("phenix").setup({
  keymap = "<leader>pp",
  width = 48,
  input_height = 4,
  conductor_command = "phenix-conductor",
  config_file = "/path/to/phenix-harness/init.lua",
})
```

Set `keymap = false` to leave mapping ownership entirely to the surrounding Neovim configuration.

Without `config_file`, the plugin checks `PHENIX_CONFIG_DIR/init.lua`, then `$XDG_CONFIG_HOME/phenix-harness/init.lua` (or `~/.config/phenix-harness/init.lua`). A missing configuration is allowed, but `session/new` still requires the conductor to have enough configuration for its standard session projection.

## Runtime model

The frontend owns one long-lived ACP client/session for the Neovim process.

Toggling the sidebar only hides or recreates its windows. It does not close the ACP session, stop `phenix-conductor`, or discard the transcript/input buffers. The conductor is stopped when `require("phenix").shutdown()` is called or Neovim exits.

The public command surface is deliberately small:

```vim
:PhenixToggle [cwd]
```

The equivalent Lua API is:

```lua
local phenix = require("phenix")

phenix.toggle({ cwd = vim.fn.getcwd() })
phenix.current()
phenix.shutdown()
```

## Transcript boundary

The first frontend version renders only submitted user text, streamed assistant text, and errors. Thinking, tool calls, plans, rich Markdown treatment, folds, follow-up controls, steering controls, model pickers, and other richer interaction surfaces are intentionally deferred.

The transcript is a normal unmodifiable text buffer. The prompt is a normal editable `acwrite` buffer. Neovim remains responsible for ordinary navigation, scrolling, selection, registers, window movement, and presentation.

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

Structured definitions are converted into canonical definition sources and parsed and validated by the conductor-side Phenix domain boundary. Lua does not maintain separate workflow execution semantics.

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

## UI boundary

There is deliberately no `phenix.keymap`, `phenix.theme`, `phenix.layout`, `phenix.input`, or generic pane API. The frontend should grow only when an interaction is actually needed, using native Neovim primitives rather than recreating an editor framework inside the plugin.
