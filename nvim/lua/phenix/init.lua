local Session = require("phenix.session")

local M = {}

local defaults = {}
local sessions = {}

local function tab_key()
  return tostring(vim.api.nvim_get_current_tabpage())
end

local function current_session()
  local session = sessions[tab_key()]
  if session and not session.closed then
    return session
  end
  return nil
end

local function require_session()
  local session = current_session()
  if not session then
    vim.notify("Phenix: no session in the current tab; run :PhenixOpen", vim.log.levels.WARN)
  end
  return session
end

function M.setup(options)
  defaults = vim.tbl_deep_extend("force", {}, defaults, options or {})
end

function M.open(options)
  local existing = current_session()
  if existing then
    existing:focus_input()
    return existing
  end

  local merged = vim.tbl_deep_extend("force", {}, defaults, options or {})
  local session = Session.new(merged)
  session:start()
  sessions[tab_key()] = session
  return session
end

function M.new(options)
  local existing = current_session()
  if existing then
    existing:close()
    sessions[tab_key()] = nil
  end
  return M.open(options)
end

function M.prompt(text)
  local session = require_session()
  if not session then
    return
  end
  if text and vim.trim(text) ~= "" then
    session:prompt(text)
  else
    session:focus_input()
  end
end

function M.config()
  local session = require_session()
  if session then
    session:config_menu()
  end
end

function M.cancel()
  local session = require_session()
  if session and not session:cancel() then
    vim.notify("Phenix: no active prompt to cancel", vim.log.levels.INFO)
  end
end

function M.close()
  local key = tab_key()
  local session = sessions[key]
  if not session then
    return
  end
  sessions[key] = nil
  session:close()
end

function M.current()
  return current_session()
end

function M._register_commands()
  vim.api.nvim_create_user_command("PhenixOpen", function(command)
    M.open({ cwd = command.args ~= "" and command.args or nil })
  end, {
    nargs = "?",
    complete = "dir",
    desc = "Open a Phenix session in a new tab",
  })

  vim.api.nvim_create_user_command("PhenixNew", function(command)
    M.new({ cwd = command.args ~= "" and command.args or nil })
  end, {
    nargs = "?",
    complete = "dir",
    desc = "Replace the current Phenix session",
  })

  vim.api.nvim_create_user_command("PhenixPrompt", function(command)
    M.prompt(command.args)
  end, {
    nargs = "*",
    desc = "Focus the composer or submit a prompt",
  })

  vim.api.nvim_create_user_command("PhenixConfig", M.config, {
    desc = "Choose an ACP session configuration option",
  })

  vim.api.nvim_create_user_command("PhenixCancel", M.cancel, {
    desc = "Cancel the active Phenix prompt",
  })

  vim.api.nvim_create_user_command("PhenixClose", M.close, {
    desc = "Close the current Phenix session",
  })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("PhenixNvimShutdown", { clear = true }),
    callback = function()
      for key, session in pairs(sessions) do
        sessions[key] = nil
        session:close(false)
      end
    end,
  })
end

return M
