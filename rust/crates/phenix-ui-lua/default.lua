phenix.theme.set("Normal", { fg = "#cdd6f4", bg = "#11111b" })
phenix.theme.set("Surface", { fg = "#cdd6f4", bg = "#1e1e2e" })
phenix.theme.set("SurfaceFocused", { fg = "#cdd6f4", bg = "#1e1e2e" })
phenix.theme.set("Heading1", { bg = "#181825" })
phenix.theme.set("Heading2", { bg = "#313244" })
phenix.theme.set("Heading3", { bg = "#45475a" })
phenix.theme.set("Heading4", { bg = "#585b70" })
phenix.theme.set("Muted", { fg = "#a6adc8" })
phenix.theme.set("Accent", { fg = "#89b4fa", bold = true })
phenix.theme.set("Success", { fg = "#a6e3a1" })
phenix.theme.set("Warning", { fg = "#f9e2af" })
phenix.theme.set("Error", { fg = "#f38ba8" })
phenix.theme.set("Thinking", { fg = "#f9e2af" })
phenix.theme.set("Tool", { fg = "#cba6f7" })
phenix.theme.set("Border", { fg = "#313244" })
phenix.theme.set("BorderFocused", { fg = "#89b4fa" })

-- The built-in workspace composition is intentionally Rust-owned for now.
-- Lua remains responsible for theme/keymap configuration; a richer window API
-- can later target the same typed pane identities without duplicating layout state.

local map = phenix.keymap.set

map("global", "<C-d>", phenix.action.quit, { desc = "Quit Phenix" })
map("global", "<C-q>", phenix.action.quit, { desc = "Quit Phenix" })
map("global", "<C-c>", phenix.action.abort, { desc = "Interrupt the selected run" })
map("global", "<C-l>", phenix.action.login, { desc = "Open authentication" })
map("global", "<C-m>", phenix.action.models, { desc = "Open model picker" })
map("global", "<C-r>", phenix.action.sessions, { desc = "Open session picker" })
map("global", "<C-b>", function()
  phenix.ui.pane.toggle("ui.sidebar")
  phenix.ui.focus.set("ui.transcript")
end, { desc = "Toggle operational sidebar" })
map("global", "<C-o>", function()
  phenix.ui.focus.set("ui.transcript")
  phenix.ui.transcript.toggle_details()
end, { desc = "Toggle details for the selected transcript turn" })
map("global", "<Tab>", function() phenix.ui.focus.move("next") end, { desc = "Focus next pane" })
map("global", "<S-Tab>", function() phenix.ui.focus.move("previous") end, { desc = "Focus previous pane" })
map("global", "<M-h>", function() phenix.ui.focus.move("left") end, { desc = "Focus left pane" })
map("global", "<M-j>", function() phenix.ui.focus.move("down") end, { desc = "Focus lower pane" })
map("global", "<M-k>", function() phenix.ui.focus.move("up") end, { desc = "Focus upper pane" })
map("global", "<M-l>", function() phenix.ui.focus.move("right") end, { desc = "Focus right pane" })

-- Input editing is intentionally handled by the typed native modal editor. A
-- user config may still override any individual key by adding an input map.

map("sidebar", "j", function() phenix.ui.pane.scroll("ui.sidebar", 1) end)
map("sidebar", "k", function() phenix.ui.pane.scroll("ui.sidebar", -1) end)
map("sidebar", "h", function() phenix.ui.focus.set("ui.transcript") end)
map("sidebar", "i", function() phenix.ui.focus.set("ui.input") end)
map("sidebar", ">", function() phenix.ui.pane.resize("ui.sidebar", "horizontal", 2) end)
map("sidebar", "<", function() phenix.ui.pane.resize("ui.sidebar", "horizontal", -2) end)

-- Transcript selection and viewport motion are deliberately independent.
-- Ctrl-N/P move between complete conversation turns; j/k always move the
-- transcript viewport by one visual line. Operations such as details/view
-- changes therefore target the selected turn without hijacking ordinary scroll.
map("transcript", "<C-n>", function() phenix.ui.transcript.move(1) end, { desc = "Select next message" })
map("transcript", "<C-p>", function() phenix.ui.transcript.move(-1) end, { desc = "Select previous message" })
map("transcript", "j", function() phenix.ui.pane.scroll("ui.transcript", -1) end, { desc = "Scroll transcript down one line" })
map("transcript", "k", function() phenix.ui.pane.scroll("ui.transcript", 1) end, { desc = "Scroll transcript up one line" })
map("transcript", "<CR>", phenix.ui.transcript.toggle_details, { desc = "Toggle selected message details" })
map("transcript", "l", function()
  phenix.ui.pane.show("ui.sidebar")
  phenix.ui.focus.set("ui.sidebar")
end)
map("transcript", "i", function() phenix.ui.focus.set("ui.input") end)
map("transcript", "G", function() phenix.ui.transcript.move(1000000) end)
map("transcript", "<Down>", function() phenix.ui.pane.scroll("ui.transcript", -1) end)
map("transcript", "<Up>", function() phenix.ui.pane.scroll("ui.transcript", 1) end)
map("transcript", "<PageDown>", function() phenix.ui.pane.scroll("ui.transcript", -10) end)
map("transcript", "<PageUp>", function() phenix.ui.pane.scroll("ui.transcript", 10) end)

map("overlay", "<CR>", phenix.overlay.accept, { desc = "Accept selected item" })
map("overlay", "<Tab>", phenix.overlay.accept, { desc = "Complete selected item" })
map("overlay", "<Esc>", phenix.overlay.cancel, { desc = "Close overlay" })
map("overlay", "j", phenix.overlay.next, { desc = "Select next item" })
map("overlay", "k", phenix.overlay.previous, { desc = "Select previous item" })
map("overlay", "<Down>", phenix.overlay.next)
map("overlay", "<Up>", phenix.overlay.previous)
map("overlay", "<BS>", phenix.input.backspace)
map("overlay", "<Del>", phenix.input.delete)
map("overlay", "<Left>", phenix.input.move_left)
map("overlay", "<Right>", phenix.input.move_right)