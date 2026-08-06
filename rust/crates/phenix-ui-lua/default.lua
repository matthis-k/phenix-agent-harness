phenix.theme.set("Normal", { fg = "#cdd6f4", bg = "#1e1e2e" })
phenix.theme.set("Surface", { fg = "#cdd6f4", bg = "#313244" })
phenix.theme.set("Muted", { fg = "#a6adc8", bg = "#1e1e2e" })
phenix.theme.set("Accent", { fg = "#89b4fa", bg = "#1e1e2e", bold = true })
phenix.theme.set("Success", { fg = "#a6e3a1", bg = "#1e1e2e" })
phenix.theme.set("Warning", { fg = "#f9e2af", bg = "#1e1e2e" })
phenix.theme.set("Error", { fg = "#f38ba8", bg = "#1e1e2e" })
phenix.theme.set("Thinking", { fg = "#f9e2af", bg = "#1e1e2e" })
phenix.theme.set("Tool", { fg = "#cba6f7", bg = "#1e1e2e" })
phenix.theme.set("Border", { fg = "#313244", bg = "#1e1e2e" })
phenix.theme.set("BorderFocused", { fg = "#89b4fa", bg = "#1e1e2e" })

phenix.layout.set(phenix.layout.split("vertical", {
  phenix.layout.pane("ui.header", { pane_type = "root", weight = 1, min = 1, max = 1 }),
  phenix.layout.split("horizontal", {
    phenix.layout.pane("ui.transcript", { pane_type = "transcript", weight = 72 }),
    phenix.layout.pane("ui.sidebar", { pane_type = "sidebar", weight = 28 }),
  }),
  phenix.layout.pane("ui.input", { pane_type = "input", weight = 4, min = 4, max = 4 }),
  phenix.layout.pane("ui.status", { pane_type = "status", weight = 1, min = 1, max = 1 }),
}))

local map = phenix.keymap.set

map("global", "<C-d>", phenix.action.quit, { desc = "Quit Phenix" })
map("global", "<C-q>", phenix.action.quit, { desc = "Quit Phenix" })
map("global", "<C-c>", phenix.action.abort, { desc = "Interrupt the selected run" })
map("global", "<Esc>", phenix.action.abort, { desc = "Interrupt or close the active surface" })
map("global", "<C-l>", phenix.action.login, { desc = "Open authentication" })
map("global", "<C-m>", phenix.action.models, { desc = "Open model picker" })
map("global", "<C-r>", phenix.action.sessions, { desc = "Open session picker" })
map("global", "<C-o>", phenix.action.toggle_details, { desc = "Toggle detailed mode" })
map("global", "<Tab>", function() phenix.ui.focus.move("next") end, { desc = "Focus next pane" })
map("global", "<S-Tab>", function() phenix.ui.focus.move("previous") end, { desc = "Focus previous pane" })

map("input", "<CR>", phenix.action.submit, { desc = "Submit prompt" })
map("input", "<S-CR>", function() phenix.input.insert("\n") end, { desc = "Insert newline" })
map("input", "<C-CR>", phenix.action.steer, { desc = "Steer active run" })
map("input", "<M-CR>", phenix.action.follow_up, { desc = "Queue follow-up" })
map("input", "<BS>", phenix.input.backspace, { desc = "Delete previous character" })
map("input", "<Del>", phenix.input.delete, { desc = "Delete character" })
map("input", "<Left>", phenix.input.move_left, { desc = "Move cursor left" })
map("input", "<Right>", phenix.input.move_right, { desc = "Move cursor right" })
map("input", "<Up>", phenix.input.history_previous, { desc = "Previous input history" })
map("input", "<Down>", phenix.input.history_next, { desc = "Next input history" })

map("sidebar", "j", function() phenix.ui.pane.scroll("ui.sidebar", 1) end)
map("sidebar", "k", function() phenix.ui.pane.scroll("ui.sidebar", -1) end)
map("sidebar", ">", function() phenix.ui.pane.resize("ui.sidebar", "horizontal", 2) end)
map("sidebar", "<", function() phenix.ui.pane.resize("ui.sidebar", "horizontal", -2) end)

-- Transcript offsets are measured from the newest content. Moving up therefore
-- increases the distance from the end; moving down decreases it.
map("transcript", "j", function() phenix.ui.pane.scroll("ui.transcript", -1) end)
map("transcript", "k", function() phenix.ui.pane.scroll("ui.transcript", 1) end)
map("transcript", "<Down>", function() phenix.ui.pane.scroll("ui.transcript", -1) end)
map("transcript", "<Up>", function() phenix.ui.pane.scroll("ui.transcript", 1) end)
map("transcript", "<PageDown>", function() phenix.ui.pane.scroll("ui.transcript", -10) end)
map("transcript", "<PageUp>", function() phenix.ui.pane.scroll("ui.transcript", 10) end)

map("overlay", "<CR>", phenix.overlay.accept, { desc = "Accept selected item" })
map("overlay", "<Esc>", phenix.overlay.cancel, { desc = "Close overlay" })
map("overlay", "j", phenix.overlay.next, { desc = "Select next item" })
map("overlay", "k", phenix.overlay.previous, { desc = "Select previous item" })
map("overlay", "<Down>", phenix.overlay.next)
map("overlay", "<Up>", phenix.overlay.previous)
map("overlay", "<BS>", phenix.input.backspace)
