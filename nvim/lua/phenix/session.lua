local Acp = require("phenix.acp")
local Config = require("phenix.config")
local Ui = require("phenix.ui")

local M = {}

local Session = {}
Session.__index = Session

local function default_config_file()
  local configured = vim.env.PHENIX_CONFIG_DIR
  if configured and configured ~= "" then
    return vim.fs.joinpath(configured, "init.lua")
  end

  local xdg = vim.env.XDG_CONFIG_HOME
  if not xdg or xdg == "" then
    local home = vim.env.HOME
    if not home or home == "" then
      return nil
    end
    xdg = vim.fs.joinpath(home, ".config")
  end

  local candidate = vim.fs.joinpath(xdg, "phenix-harness", "init.lua")
  if vim.uv.fs_stat(candidate) then
    return candidate
  end
  return nil
end

local function conductor_command(options, cwd)
  if options.conductor_command then
    local command = type(options.conductor_command) == "string"
        and { options.conductor_command }
      or vim.deepcopy(options.conductor_command)
    if options.conductor_cwd_arg ~= false then
      vim.list_extend(command, { "--cwd", cwd })
    end
    return command
  end

  local command = vim.env.PHENIX_CONDUCTOR_COMMAND
  if not command or command == "" then
    command = "phenix-conductor"
  end
  return { command, "--cwd", cwd }
end

local function format_rpc_error(prefix, error_value)
  if not error_value then
    return prefix
  end
  return string.format("%s: %s", prefix, error_value.message or vim.inspect(error_value))
end

function M.new(options)
  options = options or {}
  local cwd = vim.fs.normalize(options.cwd or vim.fn.getcwd())
  local session = setmetatable({
    cwd = cwd,
    options = vim.deepcopy(options),
    client = nil,
    ui = nil,
    session_id = nil,
    ready = false,
    prompting = false,
    closed = false,
  }, Session)

  session.ui = Ui.new({
    width = options.width,
    input_height = options.input_height,
    on_submit = function(text)
      return session:prompt(text)
    end,
  })

  session.client = Acp.new({
    command = conductor_command(options, cwd),
    cwd = cwd,
    on_notification = function(method, params)
      session:_notification(method, params)
    end,
    on_permission = function(params, respond)
      session.ui:permission(params, respond)
    end,
    on_stderr = function(message)
      session.ui:append_error(vim.trim(message))
    end,
    on_exit = function(result)
      session.ready = false
      if not session.closed and result.code ~= 0 then
        session.ui:append_error("conductor exited: " .. vim.inspect(result))
      end
    end,
  })

  return session
end

function Session:_configuration_params()
  if self.options.config == false then
    return nil
  end
  local path = self.options.config_file or default_config_file()
  if not path then
    return nil
  end
  return Config.load(path):params()
end

function Session:_fail(message, error_value)
  self.ready = false
  self.ui:append_error(format_rpc_error(message, error_value))
end

function Session:_new_standard_session()
  self.client:request("session/new", {
    cwd = self.cwd,
    mcpServers = {},
  }, function(result, error_value)
    if error_value then
      self:_fail("failed to create ACP session", error_value)
      return
    end

    self.session_id = assert(result and result.sessionId, "session/new did not return sessionId")
    self.ready = true
    if self.options.on_ready then
      self.options.on_ready(self)
    end
  end)
end

function Session:start()
  self.ui:mount()
  self.client:start(function(_, initialize_error)
    if initialize_error then
      self:_fail("failed to initialize conductor", initialize_error)
      return
    end

    local ok, configuration = pcall(function()
      return self:_configuration_params()
    end)
    if not ok then
      self:_fail("failed to load Phenix configuration: " .. tostring(configuration))
      return
    end

    if not configuration then
      self:_new_standard_session()
      return
    end

    self.client:request("_phenix/config/apply", configuration, function(_, config_error)
      if config_error then
        self:_fail("failed to apply Phenix configuration", config_error)
        return
      end
      self:_new_standard_session()
    end)
  end)
  return self
end

function Session:is_ready()
  return self.ready and not self.closed
end

function Session:prompt(text)
  text = vim.trim(text or "")
  if text == "" then
    return false
  end
  if not self.ready or not self.session_id then
    vim.notify("Phenix: session is not ready", vim.log.levels.WARN)
    return false
  end
  if self.prompting then
    vim.notify("Phenix: wait for the current prompt to finish", vim.log.levels.WARN)
    return false
  end

  self.prompting = true
  self.ui:append_user(text)
  self.client:request("session/prompt", {
    sessionId = self.session_id,
    prompt = {
      { type = "text", text = text },
    },
  }, function(_, error_value)
    self.prompting = false
    self.ui:finish_response()
    if error_value then
      self:_fail("prompt failed", error_value)
    end
  end)
  return true
end

function Session:_notification(method, params)
  if method ~= "session/update" then
    return
  end
  if self.session_id and params.sessionId ~= self.session_id then
    return
  end
  self.ui:append_update(params.update or params)
end

function Session:toggle_ui()
  self.ui:toggle()
end

function Session:focus_input()
  if not self.ui:is_visible() then
    self.ui:mount()
  else
    self.ui:focus_input()
  end
end

function Session:shutdown(close_ui)
  if self.closed then
    return
  end
  self.closed = true
  self.ready = false

  local client = self.client
  if self.session_id and client and not client.stopped then
    client:request("session/close", { sessionId = self.session_id }, function()
      client:stop()
    end)
  elseif client then
    client:stop()
  end

  if close_ui ~= false and self.ui then
    self.ui:close()
  end
end

M.Session = Session

return M
