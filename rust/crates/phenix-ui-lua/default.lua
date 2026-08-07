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

-- The built-in workspace composition remains renderer-neutral. The default
-- interaction vocabulary intentionally follows Neovim: windows use <C-w>, runs
-- behave like buffers, sessions like tabpages, transcript turns like paragraphs,
-- viewport motion uses Ctrl keys, and Space is the default <leader>.

local map = phenix.keymap.set

-- Application actions. Keep destructive/runtime actions explicit and preserve
-- canonical Vim keys such as <C-d>, <C-o>, <C-r>, <C-e>, and <C-l> for their
-- editor/navigation meanings instead of using them as application shortcuts.
map("global", "<C-q>", phenix.action.quit, { desc = "Quit Phenix" })
map("global", "<C-c>", phenix.action.abort, { desc = "Interrupt the selected run" })

-- Neovim-style window navigation. Alt-hjkl remain compatibility aliases for
-- terminals/configurations that already use the old Phenix defaults.
map("global", "<C-w>h", function() phenix.ui.focus.move("left") end, { desc = "Focus window left" })
map("global", "<C-w>j", function() phenix.ui.focus.move("down") end, { desc = "Focus window below" })
map("global", "<C-w>k", function() phenix.ui.focus.move("up") end, { desc = "Focus window above" })
map("global", "<C-w>l", function() phenix.ui.focus.move("right") end, { desc = "Focus window right" })
map("global", "<C-w>w", function() phenix.ui.focus.move("next") end, { desc = "Focus next window" })
map("global", "<C-w>W", function() phenix.ui.focus.move("previous") end, { desc = "Focus previous window" })
map("global", "<C-w>>", function(ctx) phenix.ui.pane.resize(ctx.focused_element, "horizontal", 2) end, { desc = "Widen window" })
map("global", "<C-w><lt>", function(ctx) phenix.ui.pane.resize(ctx.focused_element, "horizontal", -2) end, { desc = "Narrow window" })
map("global", "<C-w>+", function(ctx) phenix.ui.pane.resize(ctx.focused_element, "vertical", 2) end, { desc = "Increase window height" })
map("global", "<C-w>-", function(ctx) phenix.ui.pane.resize(ctx.focused_element, "vertical", -2) end, { desc = "Decrease window height" })
map("global", "<Tab>", function() phenix.ui.focus.move("next") end, { desc = "Focus next pane" })
map("global", "<S-Tab>", function() phenix.ui.focus.move("previous") end, { desc = "Focus previous pane" })
map("global", "<M-h>", function() phenix.ui.focus.move("left") end)
map("global", "<M-j>", function() phenix.ui.focus.move("down") end)
map("global", "<M-k>", function() phenix.ui.focus.move("up") end)
map("global", "<M-l>", function() phenix.ui.focus.move("right") end)

-- Runs are the buffer-like execution unit. These change the active transcript
-- without changing window focus.
map("global", "[b", function() phenix.action.move_run(-1) end, { desc = "Previous run" })
map("global", "]b", function() phenix.action.move_run(1) end, { desc = "Next run" })
map("global", "[r", function() phenix.action.move_run(-1) end, { desc = "Previous run" })
map("global", "]r", function() phenix.action.move_run(1) end, { desc = "Next run" })

-- Persisted sessions are the tabpage-like durable context.
map("global", "gt", function() phenix.action.move_session(1) end, { desc = "Next session" })
map("global", "gT", function() phenix.action.move_session(-1) end, { desc = "Previous session" })

-- Telescope-like leader namespace for Phenix-specific control surfaces.
map("global", "<leader>fm", phenix.action.models, { desc = "Find model" })
map("global", "<leader>fs", phenix.action.sessions, { desc = "Find session" })
map("global", "<leader>sn", phenix.action.new_session, { desc = "New session" })
map("global", "<leader>fa", phenix.action.login, { desc = "Authentication providers" })
map("global", "<leader>fb", function()
  phenix.ui.pane.show("ui.sidebar")
  phenix.ui.focus.set("ui.sidebar")
end, { desc = "Navigate runs" })
map("global", "<leader>tb", function()
  phenix.ui.pane.toggle("ui.sidebar")
  phenix.ui.focus.set("ui.transcript")
end, { desc = "Toggle operational sidebar" })

-- Input editing is handled by the typed native modal editor. User Lua may
-- override individual input keys without replacing the editor implementation.

-- The run tree has its own cursor. j/k move that cursor; h/l follow tree
-- semantics; Enter changes the active run; o changes it and returns to transcript.
map("sidebar", "<Esc>", function() end, { desc = "Cancel pending navigation" })
map("sidebar", "j", function() phenix.ui.sidebar.move_run(1) end, { desc = "Next visible run" })
map("sidebar", "k", function() phenix.ui.sidebar.move_run(-1) end, { desc = "Previous visible run" })
map("sidebar", "h", phenix.ui.sidebar.parent, { desc = "Collapse run or select parent" })
map("sidebar", "l", phenix.ui.sidebar.child, { desc = "Expand run or select first child" })
map("sidebar", "za", phenix.ui.sidebar.toggle, { desc = "Toggle run subtree" })
map("sidebar", "gg", function() phenix.ui.sidebar.move_run(-1000000) end, { desc = "First visible run" })
map("sidebar", "G", function() phenix.ui.sidebar.move_run(1000000) end, { desc = "Last visible run" })
map("sidebar", "<CR>", phenix.action.activate_sidebar_run, { desc = "Open run transcript" })
map("sidebar", "o", function()
  phenix.action.activate_sidebar_run()
  phenix.ui.focus.set("ui.transcript")
end, { desc = "Open run and focus transcript" })
map("sidebar", "i", function() phenix.ui.focus.set("ui.input") end, { desc = "Enter composer" })

-- Transcript selection and viewport motion are independent. j/k and {/} move
-- semantic conversation turns; Ctrl motions scroll the rendered viewport without
-- changing the selected turn. Rich-block-local controls remain native below this
-- keymap (currently [ ], v/V, H/L, J/K).
map("transcript", "<Esc>", function() end, { desc = "Cancel pending navigation" })
map("transcript", "j", function() phenix.ui.transcript.move(1) end, { desc = "Next conversation turn" })
map("transcript", "k", function() phenix.ui.transcript.move(-1) end, { desc = "Previous conversation turn" })
map("transcript", "}", function() phenix.ui.transcript.move(1) end, { desc = "Next conversation turn" })
map("transcript", "{", function() phenix.ui.transcript.move(-1) end, { desc = "Previous conversation turn" })
map("transcript", "<C-n>", function() phenix.ui.transcript.move(1) end, { desc = "Next conversation turn" })
map("transcript", "<C-p>", function() phenix.ui.transcript.move(-1) end, { desc = "Previous conversation turn" })
map("transcript", "gg", function() phenix.ui.transcript.move(-1000000) end, { desc = "First conversation turn" })
map("transcript", "G", function() phenix.ui.transcript.move(1000000) end, { desc = "Latest conversation turn" })
map("transcript", "za", phenix.ui.transcript.toggle_details, { desc = "Toggle selected turn details" })
map("transcript", "<CR>", phenix.ui.transcript.toggle_details, { desc = "Toggle selected turn details" })
map("transcript", "i", function() phenix.ui.focus.set("ui.input") end, { desc = "Enter composer" })

map("transcript", "<C-e>", function() phenix.ui.pane.scroll("ui.transcript", -1) end, { desc = "Scroll down one line" })
map("transcript", "<C-y>", function() phenix.ui.pane.scroll("ui.transcript", 1) end, { desc = "Scroll up one line" })
map("transcript", "<C-d>", function() phenix.ui.pane.scroll("ui.transcript", -10) end, { desc = "Scroll down half page" })
map("transcript", "<C-u>", function() phenix.ui.pane.scroll("ui.transcript", 10) end, { desc = "Scroll up half page" })
map("transcript", "<C-f>", function() phenix.ui.pane.scroll("ui.transcript", -20) end, { desc = "Scroll down page" })
map("transcript", "<C-b>", function() phenix.ui.pane.scroll("ui.transcript", 20) end, { desc = "Scroll up page" })
map("transcript", "<Down>", function() phenix.ui.pane.scroll("ui.transcript", -1) end)
map("transcript", "<Up>", function() phenix.ui.pane.scroll("ui.transcript", 1) end)
map("transcript", "<PageDown>", function() phenix.ui.pane.scroll("ui.transcript", -10) end)
map("transcript", "<PageUp>", function() phenix.ui.pane.scroll("ui.transcript", 10) end)

-- Pickers use one shared interaction contract, matching common Telescope/fuzzy
-- finder muscle memory.
map("overlay", "<CR>", phenix.overlay.accept, { desc = "Accept selected item" })
map("overlay", "<C-y>", phenix.overlay.accept, { desc = "Accept selected item" })
map("overlay", "<Tab>", phenix.overlay.accept, { desc = "Complete selected item" })
map("overlay", "<Esc>", phenix.overlay.cancel, { desc = "Close overlay" })
map("overlay", "<C-c>", phenix.overlay.cancel, { desc = "Close overlay" })
map("overlay", "j", phenix.overlay.next, { desc = "Select next item" })
map("overlay", "k", phenix.overlay.previous, { desc = "Select previous item" })
map("overlay", "<C-n>", phenix.overlay.next, { desc = "Select next item" })
map("overlay", "<C-p>", phenix.overlay.previous, { desc = "Select previous item" })
map("overlay", "<Down>", phenix.overlay.next)
map("overlay", "<Up>", phenix.overlay.previous)
map("overlay", "<BS>", phenix.input.backspace)
map("overlay", "<Del>", phenix.input.delete)
map("overlay", "<Left>", phenix.input.move_left)
map("overlay", "<Right>", phenix.input.move_right)
