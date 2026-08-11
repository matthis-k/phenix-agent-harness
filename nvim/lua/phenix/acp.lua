local M = {}

local Client = {}
Client.__index = Client

local function schedule(callback, ...)
  local args = { ... }
  vim.schedule(function()
    callback(unpack(args))
  end)
end

local function rpc_error(code, message)
  return { code = code, message = message }
end

local function normalize_command(command)
  if type(command) == "string" then
    return { command }
  end
  assert(type(command) == "table" and #command > 0, "ACP command must be a string or non-empty argv table")
  return vim.deepcopy(command)
end

function M.new(options)
  options = options or {}
  return setmetatable({
    command = normalize_command(options.command or "phenix-conductor"),
    cwd = options.cwd or vim.fn.getcwd(),
    next_id = 1,
    pending = {},
    stdout_tail = "",
    process = nil,
    stopped = false,
    on_notification = options.on_notification or function() end,
    on_permission = options.on_permission,
    on_stderr = options.on_stderr or function() end,
    on_exit = options.on_exit or function() end,
  }, Client)
end

function Client:_write(message)
  if not self.process or self.stopped then
    return false, "ACP process is not running"
  end
  local ok, error_message = pcall(self.process.write, self.process, vim.json.encode(message) .. "\n")
  if not ok then
    return false, tostring(error_message)
  end
  return true
end

function Client:request(method, params, callback)
  assert(type(method) == "string" and method ~= "", "ACP request method must be non-empty")
  local id = self.next_id
  self.next_id = self.next_id + 1
  self.pending[id] = callback or function() end
  local ok, error_message = self:_write({
    jsonrpc = "2.0",
    id = id,
    method = method,
    params = params or {},
  })
  if not ok then
    local pending = self.pending[id]
    self.pending[id] = nil
    schedule(pending, nil, rpc_error(-32000, error_message))
  end
  return id
end

function Client:notify(method, params)
  assert(type(method) == "string" and method ~= "", "ACP notification method must be non-empty")
  return self:_write({
    jsonrpc = "2.0",
    method = method,
    params = params or {},
  })
end

function Client:_respond(id, result, error_value)
  local message = {
    jsonrpc = "2.0",
    id = id,
  }
  if error_value then
    message.error = error_value
  else
    message.result = result or {}
  end
  self:_write(message)
end

function Client:_permission_request(message)
  local params = message.params or {}
  if not self.on_permission then
    self:_respond(message.id, {
      outcome = { outcome = "cancelled" },
    })
    return
  end

  self.on_permission(params, function(option_id)
    if option_id then
      self:_respond(message.id, {
        outcome = {
          outcome = "selected",
          optionId = option_id,
        },
      })
    else
      self:_respond(message.id, {
        outcome = { outcome = "cancelled" },
      })
    end
  end)
end

function Client:_dispatch(message)
  if message.id ~= nil and message.method == nil then
    local callback = self.pending[message.id]
    if not callback then
      return
    end
    self.pending[message.id] = nil
    callback(message.result, message.error)
    return
  end

  if message.method and message.id ~= nil then
    if message.method == "session/request_permission" then
      self:_permission_request(message)
    else
      self:_respond(message.id, nil, rpc_error(-32601, "unsupported ACP client method: " .. message.method))
    end
    return
  end

  if message.method then
    self.on_notification(message.method, message.params or {})
  end
end

function Client:_consume_stdout(data)
  if not data or data == "" then
    return
  end
  local text = self.stdout_tail .. data
  local start = 1
  while true do
    local newline = text:find("\n", start, true)
    if not newline then
      break
    end
    local line = text:sub(start, newline - 1):gsub("\r$", "")
    start = newline + 1
    if line ~= "" then
      local ok, message = pcall(vim.json.decode, line)
      if ok then
        self:_dispatch(message)
      else
        self.on_stderr("invalid ACP JSON: " .. tostring(message) .. "\n" .. line)
      end
    end
  end
  self.stdout_tail = text:sub(start)
end

function Client:start(callback)
  assert(not self.process, "ACP client has already been started")
  callback = callback or function() end

  local ok, process_or_error = pcall(vim.system, self.command, {
    cwd = self.cwd,
    stdin = true,
    text = true,
    stdout = function(error_message, data)
      schedule(function()
        if error_message then
          self.on_stderr(error_message)
          return
        end
        self:_consume_stdout(data)
      end)
    end,
    stderr = function(error_message, data)
      schedule(function()
        if error_message then
          self.on_stderr(error_message)
        elseif data and data ~= "" then
          self.on_stderr(data)
        end
      end)
    end,
  }, function(result)
    schedule(function()
      self.stopped = true
      self.process = nil
      for id, pending in pairs(self.pending) do
        self.pending[id] = nil
        pending(nil, rpc_error(-32001, "ACP process exited before request " .. id .. " completed"))
      end
      self.on_exit(result)
    end)
  end)

  if not ok then
    callback(nil, rpc_error(-32000, tostring(process_or_error)))
    return
  end
  self.process = process_or_error

  self:request("initialize", {
    protocolVersion = 1,
    clientCapabilities = {},
    clientInfo = {
      name = "phenix-nvim",
      version = "0",
    },
  }, callback)
end

function Client:stop()
  if self.stopped then
    return
  end
  self.stopped = true
  if self.process then
    pcall(self.process.write, self.process, nil)
    pcall(self.process.kill, self.process, "sigterm")
    self.process = nil
  end
end

M.Client = Client

return M
