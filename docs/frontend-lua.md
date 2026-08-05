# Lua frontend configuration

Phenix frontend behavior is provided by an embedded Lua configuration provider. The provider is not a Ratatui plugin: it produces renderer-neutral theme, layout, keymap, and frontend-command values.

The native terminal application and a future `phenix-ai.nvim` adapter consume the same provider contract.

## Loading

Configuration precedence is:

1. `phenix --config /path/to/init.lua`
2. `PHENIX_CONFIG`
3. `$XDG_CONFIG_HOME/phenix/init.lua`
4. `$HOME/.config/phenix/init.lua`

The built-in configuration is evaluated first. User configuration may override or delete any built-in mapping. `--no-default-config` skips the built-in Lua file.

`phenix --print-default-config` prints the exact built-in Lua source.

## Provider boundary

```text
init.lua
  -> LuaFrontendProvider
      -> FrontendConfig
           theme
           layout tree
           keymap descriptions
      -> key callback
           FrontendCommand[]
              application
              UI routing
              input editing
              overlay behavior
```

The provider does not expose Ratatui widgets, terminal handles, Neovim windows, backend sessions, or mutable `AppState` references.

Lua callbacks execute on the single frontend-reactivity owner thread. They append semantic commands to a callback-local collector. The owner loop applies those commands after the callback returns.

## Keymaps

```lua
phenix.keymap.set("sidebar", ">", function()
  phenix.ui.pane.resize("ui.sidebar", "horizontal", 2)
end, { desc = "Grow sidebar" })

phenix.keymap.del("global", "<C-q>")
phenix.keymap.clear("transcript")
```

Scopes are pane types:

- `global`
- `root`
- `layout`
- `sidebar`
- `transcript`
- `input`
- `status`
- `overlay`

Pane mappings are resolved before global mappings. The same chord can therefore have different behavior in different pane types.

Both Neovim-style notation and explicit modifier notation are accepted:

```lua
"<C-d>"
"<M-CR>"
"<S-Tab>"
"ctrl+d"
"alt+enter"
```

Unmapped printable characters fall through to text insertion. Control and navigation behavior comes from Lua mappings rather than hidden native defaults.

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
phenix.ui.pane.resize("ui.input", "vertical", -1)
phenix.ui.pane.set_size("ui.sidebar", "horizontal", 32)
phenix.ui.pane.show("ui.sidebar")
phenix.ui.pane.hide("ui.sidebar")
phenix.ui.pane.toggle("ui.sidebar")
phenix.ui.pane.scroll("ui.transcript", 10)

phenix.ui.invalidate()
```

These functions emit routed UI events. The layout/reactivity owner applies the resulting view mutations; Lua never mutates renderer state directly.

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

Themes use semantic highlight groups rather than Ratatui or Neovim-specific style objects.

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

The Ratatui adapter maps highlight groups to terminal styles. A Neovim adapter can map the same groups to `nvim_set_hl` definitions.

## Layout

Layouts are renderer-neutral trees of panes and splits.

```lua
phenix.layout.set(phenix.layout.split("vertical", {
  phenix.layout.pane("ui.header", { weight = 1 }),
  phenix.layout.split("horizontal", {
    phenix.layout.pane("ui.transcript", {
      pane_type = "transcript",
      weight = 72,
    }),
    phenix.layout.pane("ui.sidebar", {
      pane_type = "sidebar",
      weight = 28,
    }),
  }),
  phenix.layout.pane("ui.input", { pane_type = "input", weight = 4 }),
  phenix.layout.pane("ui.status", { pane_type = "status", weight = 1 }),
}))
```

Pane options are:

- `pane_type`
- `weight`
- `min`
- `max`

Runtime resize commands override the corresponding pane dimension in view state without modifying the declarative layout tree.

## Nix wrappers

The flake exposes:

```nix
legacyPackages.${system}.phenixFrontend.mkPhenixWrapper {
  configText = ''
    phenix.keymap.del("global", "<C-q>")
    phenix.keymap.set("sidebar", "<C-l>", function()
      phenix.ui.focus.set("ui.transcript")
    end)
  '';
}
```

`configFile = ./init.lua` may be used instead of `configText`. The generated wrapper sets `PHENIX_CONFIG`, while an explicit `--config` argument still takes precedence.

## Neovim adoption

A future `phenix-ai.nvim` should consume `phenix-frontend-config` and `phenix-ui-lua`, then provide a Neovim adapter for:

- semantic layout trees to windows and splits,
- semantic highlight groups to Neovim highlight definitions,
- frontend commands to window, focus, buffer, and Phenix-runtime operations,
- routed content events to buffer projections.

The Lua configuration API should remain the same between the native TUI and Neovim. Renderer-specific operations must not be added to the provider contract; they belong in adapter crates or plugin code.
