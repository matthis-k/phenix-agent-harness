local Session = require("phenix.session")

local M = {}

local defaults = {
  keymap = "<leader>pp",
  width = 48,
  input_height = 4,
}
local session = nil
local mapped_key = nil

local function map_toggle(lhs)
  if mapped_key and mapped_key ~= lhs then
    pcall(vim.keymap.del, "n", mapped_key)
    mapped_key = nil
  end
  if not lhs or lhs == false or mapped_key == lhs then
    return
  end

  vim.keymap.set("n", lhs, function()
    M.toggle()
  end, { desc = "Phenix: toggle sidebar" })
  mapped_key = lhs
end

function M.setup(options)
  defaults = vim.tbl_deep_extend("force", {}, defaults, options or {})
  map_toggle(defaults.keymap)
end

function M.toggle(options)
  if session and not session.closed then
    session:toggle_ui()
    return session
  end

  local merged = vim.tbl_deep_extend("force", {}, defaults, options or {})
  session = Session.new(merged)
  session:start()
  return session
end

function M.current()
  if session and not session.closed then
    return session
  end
  return nil
end

function M.shutdown()
  if not session then
    return
  end
  local current = session
  session = nil
  current:shutdown()
end

function M._register_commands()
  vim.api.nvim_create_user_command("PhenixToggle", function(command)
    M.toggle({ cwd = command.args ~= "" and command.args or nil })
  end, {
    nargs = "?",
    complete = "dir",
    desc = "Toggle the Phenix sidebar",
  })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("PhenixNvimShutdown", { clear = true }),
    callback = function()
      if session then
        local current = session
        session = nil
        current:shutdown(false)
      end
    end,
  })
end

return M
