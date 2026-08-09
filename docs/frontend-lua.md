# Lua frontend configuration

Lua is a first-class **authoring surface** for the native frontend and the policy submitted to the Phenix conductor. It does not own conductor runtime state, downstream ACP sessions, or Ratatui widgets.

The architectural boundary is described in the root [`README.md`](../README.md). This document is only the user-facing Lua API reference.

## Loading

The native frontend loads built-in Lua defaults first unless `--no-default-config` is used, then evaluates the selected `config.lua`.

Configuration is discovered under the Phenix Harness config directory or selected explicitly with `-p/--config-dir`.

```sh
phenix --print-default-config
```

prints the built-in Lua defaults.

## ACP authoring

Lua may describe the application configuration submitted through `_phenix/config/apply`:

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

Structured and external sources converge through the same canonical Phenix definition parser. Lua does not maintain separate workflow semantics.

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

## Keymaps

```lua
phenix.keymap.set("sidebar", ">", function()
  phenix.ui.pane.resize("ui.sidebar", "horizontal", 2)
end, { desc = "Grow sidebar" })

phenix.keymap.del("global", "<C-q>")
phenix.keymap.clear("transcript")
```

Scopes are semantic frontend contexts. Neovim-style notation and explicit modifier notation are accepted, for example:

```lua
"<C-d>"
"<M-CR>"
"<S-Tab>"
"ctrl+d"
"alt+enter"
```

Unmapped printable input falls through to the native input editor when appropriate.

## Application actions

Application actions emit semantic frontend/runtime intents:

```lua
phenix.action.submit()
phenix.action.steer()
phenix.action.follow_up()
phenix.action.abort()
phenix.action.quit()
phenix.action.login()
phenix.action.models()
phenix.action.sessions()
phenix.action.toggle_details()
phenix.action.close_overlay()
```

They do not invoke a particular downstream agent directly.

## UI commands

Lua may manipulate existing typed frontend state:

```lua
phenix.ui.focus.set("ui.input")
phenix.ui.focus.move("left")
phenix.ui.focus.move("next")

phenix.ui.pane.resize("ui.sidebar", "horizontal", 4)
phenix.ui.pane.set_size("ui.sidebar", "horizontal", 32)
phenix.ui.pane.show("ui.sidebar")
phenix.ui.pane.hide("ui.sidebar")
phenix.ui.pane.toggle("ui.sidebar")
phenix.ui.pane.scroll("ui.transcript", 10)

phenix.ui.invalidate()
```

These commands act on Rust-owned panes. Lua does not own the pane tree or renderer.

## Input and overlays

```lua
phenix.input.insert("text")
phenix.input.backspace()
phenix.input.delete()
phenix.input.move_left()
phenix.input.move_right()
phenix.input.history_previous()
phenix.input.history_next()

phenix.overlay.next()
phenix.overlay.previous()
phenix.overlay.accept()
phenix.overlay.cancel()
```

Overlay acceptance is semantic; the frontend resolves it against the active model picker, authentication flow, session picker, or extension dialog.

## Theme

Themes use semantic highlight groups rather than Ratatui-specific style values:

```lua
phenix.theme.set("Accent", {
  fg = "#89b4fa",
  bg = "#1e1e2e",
  bold = true,
})

phenix.theme.del("Tool")
phenix.theme.reset()
```

Colors may be `#RRGGBB`, named terminal colors, palette indices, or RGB tables.

## Window composition

Window composition is currently Rust-owned. There is deliberately no `phenix.layout.*` constructor API.

If a more general window API is introduced, it should operate on stable typed pane/window identities and remain renderer-neutral. The TUI should continue to consume that shared model rather than becoming a special-case layout runtime.
