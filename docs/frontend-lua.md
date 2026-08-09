# Lua frontend configuration

Phenix currently keeps native window composition and rendering in Rust. The embedded Lua provider configures semantic theme groups, keymaps, frontend commands, and the user-authored Phenix ACP policy submitted to the conductor; it does not construct the window tree or own conductor runtime state.

A future Neovim-like window API is intentionally deferred until the native workspace model has settled. The current Lua API should not be treated as that future window API.

## Loading

The native frontend loads the built-in Lua defaults first unless `--no-default-config` is used, then evaluates the selected user configuration. The packaged wrapper falls back to the packaged `config/phenix-harness` authoring root when no user `config.lua` exists.

`phenix --print-default-config` prints the exact built-in Lua source.

## Provider boundary

```text
config.lua
  -> LuaFrontendProvider
      -> FrontendConfig
           semantic theme groups
           keymap descriptions
           Rust-owned layout value
      -> AcpApplicationConfig
           backend descriptors
           workflow definitions
           routing definitions
           standard-session template
      -> key callback
           FrontendCommand[]
              application
              UI routing
              input editing
              overlay behavior
```

The provider does not expose Ratatui widgets, terminal handles, windows, backend sessions, mutable `AppState` references, or conductor runtime ownership. It also does not expose a layout-construction API.

Lua callbacks execute on the single frontend-reactivity owner thread. They append semantic commands to a callback-local collector. The owner loop applies those commands after the callback returns.

## Phenix ACP authoring

Lua is a first-class authoring surface for the policy that Phenix submits through `_phenix/config/apply`. It does not construct the runtime itself: the conductor parses and validates the definitions, constructs the immutable configuration revision, and future session trees pin that revision.

The configuration root is explicit:

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

Workflows can be authored directly as structured Lua rather than stored in a second Markdown configuration tree:

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

Routing tables likewise carry the full D0-D4 model configuration explicitly:

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

The path and inline-source descriptor forms remain available for external definition files:

```lua
phenix.acp.workflow("workflows/custom.md")
phenix.acp.routing_table({ source = source, format = "markdown" })
```

Structured definitions are converted at the authoring boundary and then passed through the same canonical Phenix definition parser as external sources. Lua therefore does not maintain a second workflow or routing semantics implementation.

Difficulty is runtime policy, not prompt text. A workflow start carries D0-D4 and the active router selects a complete `backend/provider/model/thinking` target using role, workflow, and difficulty. Workflow-specific routing rows may deliberately constrain a workflow to stronger model/thinking configurations without changing the reusable role vocabulary.

## Keymaps

```lua
phenix.keymap.set("sidebar", ">", function()
  phenix.ui.pane.resize("ui.sidebar", "horizontal", 2)
end, { desc = "Grow sidebar" })

phenix.keymap.del("global", "<C-q>")
phenix.keymap.clear("transcript")
```

Scopes are pane types. The native workspace currently defines stable identities for the transcript, operational sidebar, lower-level inspector, specialized inspection surface, composer, status line, and overlays. Only panes that participate in the current focus model receive pane-local mappings.

Both Neovim-style notation and explicit modifier notation are accepted:

```lua
"<C-d>"
"<M-CR>"
"<S-Tab>"
"ctrl+d"
"alt+enter"
```

Unmapped printable characters fall through to the native input editor when the input pane is focused.

## Application actions

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

These produce semantic application intents. They do not invoke Pi directly.

## UI commands

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

These are mutations of existing Rust-owned panes, not window construction. The runtime applies them to typed view state; Lua never owns the pane tree or renderer state.

The built-in native workspace modes are also Rust-owned:

- `Alt-1`: default — transcript plus operational sidebar
- `Alt-2`: advanced — lower-level inspector, transcript, and operational sidebar
- `Alt-3`: zen — transcript/composer/status only
- `Alt-4`: specialized — focused exact run/workflow inspection

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

Overlay acceptance remains semantic. The runtime adapter resolves it against the active model picker, authentication prompt, session picker, or extension dialog.

## Theme

Themes use semantic highlight groups rather than Ratatui-specific style objects.

```lua
phenix.theme.set("Accent", {
  fg = "#89b4fa",
  bg = "#1e1e2e",
  bold = true,
})

phenix.theme.del("Tool")
phenix.theme.reset()
```

Color values may be:

- `#RRGGBB`
- named colors such as `blue` or `dark-gray`
- terminal palette indices from `0` to `255`
- `{ r = 137, g = 180, b = 250 }`

The Ratatui adapter maps highlight groups to terminal styles. A future Neovim frontend can map the same semantic groups to Neovim highlights without inheriting the current terminal window implementation.

## Window composition

Window composition is intentionally native Rust code for now. `LayoutConfig::default()` defines the superset workspace tree, while typed pane visibility selects the default, advanced, zen, or specialized composition.

There is deliberately no `phenix.layout.*` Lua API. The earlier provisional split/pane constructor was removed rather than preserved as a compatibility surface.

The eventual Neovim-esque window API should be designed around the settled typed primitives—stable pane IDs, splits, focus, visibility, sizing, and workspace composition—rather than being constrained by that removed prototype.

## Future Neovim-style API

The likely direction is an API analogous to Neovim's window model: windows/panes have stable identities, split relationships are inspectable, and open/close/focus/resize operations act on those identities. That API does not exist yet.

When it is introduced, renderer-specific handles should stay behind adapters. The native TUI should remain a consumer of the same typed window model rather than becoming a special case or keeping a second layout API alive.
