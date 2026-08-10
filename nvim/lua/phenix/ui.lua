local M = {}

local Split = require("nui.split")
local Menu = require("nui.menu")

local UI = {}
UI.__index = UI

local function set_modifiable(buffer, value)
  vim.api.nvim_set_option_value("modifiable", value, { buf = buffer })
end

local function split_text(text)
  local lines = {}
  local start = 1
  while true do
    local newline = text:find("\n", start, true)
    if not newline then
      table.insert(lines, text:sub(start))
      break
    end
    table.insert(lines, text:sub(start, newline - 1))
    start = newline + 1
  end
  return lines
end

local function option_label(option)
  local category = option.category and (" · " .. option.category) or ""
  return string.format("%s%s  [%s]", option.name or option.id or "option", category, tostring(option.currentValue))
end

function M.new(options)
  options = options or {}
  local buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buffer, "phenix://transcript/" .. tostring(buffer))
  vim.api.nvim_set_option_value("buftype", "nofile", { buf = buffer })
  vim.api.nvim_set_option_value("bufhidden", "wipe", { buf = buffer })
  vim.api.nvim_set_option_value("swapfile", false, { buf = buffer })
  vim.api.nvim_set_option_value("filetype", "markdown", { buf = buffer })
  vim.api.nvim_set_option_value("modifiable", true, { buf = buffer })
  vim.api.nvim_buf_set_lines(buffer, 0, -1, false, { "# Phenix", "" })
  vim.api.nvim_set_option_value("modifiable", false, { buf = buffer })

  return setmetatable({
    transcript_buffer = buffer,
    transcript_window = nil,
    input = nil,
    active_stream = nil,
    active_fold_start = nil,
    config_options = {},
    on_submit = options.on_submit or function() end,
    on_close = options.on_close or function() end,
    closed = false,
  }, UI)
end

function UI:_append_lines(lines)
  if #lines == 0 then
    return
  end
  set_modifiable(self.transcript_buffer, true)
  vim.api.nvim_buf_set_lines(self.transcript_buffer, -1, -1, false, lines)
  set_modifiable(self.transcript_buffer, false)
end

function UI:_append_to_last_line(text)
  local line_count = vim.api.nvim_buf_line_count(self.transcript_buffer)
  local current = vim.api.nvim_buf_get_lines(self.transcript_buffer, line_count - 1, line_count, false)[1] or ""
  local chunks = split_text(text)
  set_modifiable(self.transcript_buffer, true)
  vim.api.nvim_buf_set_lines(
    self.transcript_buffer,
    line_count - 1,
    line_count,
    false,
    { current .. (chunks[1] or "") }
  )
  if #chunks > 1 then
    vim.api.nvim_buf_set_lines(self.transcript_buffer, -1, -1, false, vim.list_slice(chunks, 2))
  end
  set_modifiable(self.transcript_buffer, false)
end

function UI:_close_fold()
  if not self.active_fold_start or not self.transcript_window or not vim.api.nvim_win_is_valid(self.transcript_window) then
    self.active_fold_start = nil
    return
  end
  local finish = vim.api.nvim_buf_line_count(self.transcript_buffer)
  if finish > self.active_fold_start then
    local start = self.active_fold_start
    vim.api.nvim_win_call(self.transcript_window, function()
      pcall(vim.cmd, string.format("silent! %d,%dfold", start, finish))
    end)
  end
  self.active_fold_start = nil
end

function UI:_begin_stream(kind, heading, foldable)
  if self.active_stream == kind then
    return
  end
  self:_close_fold()
  self.active_stream = kind
  self:_append_lines({ "", "### " .. heading, "" })
  if foldable then
    self.active_fold_start = vim.api.nvim_buf_line_count(self.transcript_buffer) - 1
  end
end

function UI:append_stream(kind, heading, text, foldable)
  if not text or text == "" then
    return
  end
  self:_begin_stream(kind, heading, foldable)
  self:_append_to_last_line(text)
  self:follow()
end

function UI:append_block(heading, value, foldable)
  self:_close_fold()
  self.active_stream = nil
  self:_append_lines({ "", "### " .. heading, "" })
  local start = vim.api.nvim_buf_line_count(self.transcript_buffer) - 1
  local text = type(value) == "string" and value or vim.inspect(value)
  self:_append_lines(split_text(text))
  if foldable and self.transcript_window and vim.api.nvim_win_is_valid(self.transcript_window) then
    local finish = vim.api.nvim_buf_line_count(self.transcript_buffer)
    vim.api.nvim_win_call(self.transcript_window, function()
      pcall(vim.cmd, string.format("silent! %d,%dfold", start, finish))
    end)
  end
  self:follow()
end

function UI:append_update(update)
  local kind = update and update.sessionUpdate
  if kind == "agent_message_chunk" then
    local content = update.content or {}
    self:append_stream("assistant", "Assistant", content.text or "", false)
  elseif kind == "agent_thought_chunk" then
    local content = update.content or {}
    self:append_stream("thought", "Thinking", content.text or "", true)
  elseif kind == "user_message_chunk" then
    local content = update.content or {}
    self:append_stream("user", "You", content.text or "", false)
  elseif kind == "tool_call" then
    local title = update.title or update.name or update.toolCallId or "Tool"
    local body = {
      id = update.toolCallId,
      status = update.status,
      kind = update.kind,
      input = update.rawInput,
    }
    self:append_block("Tool · " .. title, body, true)
  elseif kind == "tool_call_update" then
    local body = {
      id = update.toolCallId,
      status = update.status,
      output = update.rawOutput,
      content = update.content,
    }
    self:append_block("Tool update · " .. tostring(update.toolCallId or "tool"), body, true)
  elseif kind == "plan" then
    self:append_block("Plan", update.entries or update, true)
  elseif kind == "config_option_update" or kind == "config_options_update" then
    self:set_config_options(update.configOptions or {})
  elseif kind == "available_commands_update" then
    self.available_commands = update.availableCommands or update.commands or {}
  elseif update then
    self:append_block("ACP update · " .. tostring(kind or "unknown"), update, true)
  end
end

function UI:set_config_options(options)
  self.config_options = options or {}
  self:update_status()
end

function UI:update_status(extra)
  if not self.transcript_window or not vim.api.nvim_win_is_valid(self.transcript_window) then
    return
  end
  local parts = { "Phenix" }
  for _, option in ipairs(self.config_options) do
    if option.category == "model" or option.category == "thought_level" or option.category == "mode" then
      table.insert(parts, string.format("%s: %s", option.name or option.id, tostring(option.currentValue)))
    end
  end
  if extra and extra ~= "" then
    table.insert(parts, extra)
  end
  vim.api.nvim_set_option_value("winbar", " " .. table.concat(parts, " · ") .. " ", { win = self.transcript_window })
end

function UI:follow()
  if not self.transcript_window or not vim.api.nvim_win_is_valid(self.transcript_window) then
    return
  end
  local line_count = vim.api.nvim_buf_line_count(self.transcript_buffer)
  vim.api.nvim_win_set_cursor(self.transcript_window, { line_count, 0 })
end

function UI:text()
  return table.concat(vim.api.nvim_buf_get_lines(self.transcript_buffer, 0, -1, false), "\n")
end

function UI:_submit_input()
  if not self.input or not self.input.bufnr or not vim.api.nvim_buf_is_valid(self.input.bufnr) then
    return
  end
  local lines = vim.api.nvim_buf_get_lines(self.input.bufnr, 0, -1, false)
  local text = vim.trim(table.concat(lines, "\n"))
  if text == "" then
    return
  end
  vim.api.nvim_buf_set_lines(self.input.bufnr, 0, -1, false, { "" })
  self.on_submit(text)
end

function UI:focus_input()
  if self.input and self.input.winid and vim.api.nvim_win_is_valid(self.input.winid) then
    vim.api.nvim_set_current_win(self.input.winid)
    vim.cmd("startinsert")
  end
end

function UI:mount()
  vim.cmd("tabnew")
  self.transcript_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(self.transcript_window, self.transcript_buffer)
  vim.api.nvim_set_option_value("wrap", true, { win = self.transcript_window })
  vim.api.nvim_set_option_value("linebreak", true, { win = self.transcript_window })
  vim.api.nvim_set_option_value("foldmethod", "manual", { win = self.transcript_window })
  vim.api.nvim_set_option_value("foldenable", true, { win = self.transcript_window })

  self.input = Split({
    relative = "editor",
    position = "bottom",
    size = 6,
    enter = true,
    buf_options = {
      buftype = "nofile",
      bufhidden = "wipe",
      swapfile = false,
      filetype = "markdown",
    },
    win_options = {
      wrap = true,
      linebreak = true,
      winfixheight = true,
    },
  })
  self.input:mount()
  vim.api.nvim_buf_set_name(self.input.bufnr, "phenix://composer/" .. tostring(self.input.bufnr))
  vim.api.nvim_buf_set_lines(self.input.bufnr, 0, -1, false, { "" })

  vim.keymap.set("n", "<CR>", function()
    self:_submit_input()
  end, { buffer = self.input.bufnr, desc = "Phenix: submit prompt" })
  vim.keymap.set("i", "<C-s>", function()
    self:_submit_input()
  end, { buffer = self.input.bufnr, desc = "Phenix: submit prompt" })

  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = self.transcript_buffer,
    once = true,
    callback = function()
      if not self.closed then
        self.on_close()
      end
    end,
  })

  self:update_status("connecting")
  self:focus_input()
end

function UI:permission(params, respond)
  local options = params.options or {}
  local lines = {}
  for _, option in ipairs(options) do
    table.insert(lines, Menu.item(option.name or option.optionId or "permission", {
      option_id = option.optionId,
      kind = option.kind,
    }))
  end
  if #lines == 0 then
    respond(nil)
    return
  end
  local title = ((params.toolCall or {}).title) or "Permission"
  local menu
  menu = Menu({
    relative = "editor",
    position = "50%",
    size = { width = 64, height = math.min(#lines + 2, 16) },
    border = { style = "single", text = { top = " " .. title .. " ", top_align = "center" } },
  }, {
    lines = lines,
    keymap = {
      focus_next = { "j", "<Down>" },
      focus_prev = { "k", "<Up>" },
      close = { "<Esc>", "q" },
      submit = { "<CR>" },
    },
    on_submit = function(item)
      respond(item.option_id)
    end,
    on_close = function()
      respond(nil)
    end,
  })
  menu:mount()
end

function UI:config_menu(on_select)
  if #self.config_options == 0 then
    vim.notify("Phenix: this session exposes no configuration options", vim.log.levels.INFO)
    return
  end
  local lines = {}
  for _, option in ipairs(self.config_options) do
    table.insert(lines, Menu.item(option_label(option), { option = option }))
  end
  local menu
  menu = Menu({
    relative = "editor",
    position = "50%",
    size = { width = 72, height = math.min(#lines + 2, 18) },
    border = { style = "single", text = { top = " Session configuration ", top_align = "center" } },
  }, {
    lines = lines,
    keymap = {
      focus_next = { "j", "<Down>" },
      focus_prev = { "k", "<Up>" },
      close = { "<Esc>", "q" },
      submit = { "<CR>" },
    },
    on_submit = function(item)
      local option = item.option
      if option.type == "boolean" then
        on_select(option, not option.currentValue)
        return
      end
      local values = {}
      for _, value in ipairs(option.options or {}) do
        if value.options then
          for _, nested in ipairs(value.options) do
            table.insert(values, nested)
          end
        else
          table.insert(values, value)
        end
      end
      if #values == 0 then
        vim.notify("Phenix: unsupported configuration option type " .. tostring(option.type), vim.log.levels.WARN)
        return
      end
      local value_lines = {}
      for _, value in ipairs(values) do
        local label = value.name or value.label or value.value
        if value.value == option.currentValue then
          label = label .. "  ✓"
        end
        table.insert(value_lines, Menu.item(label, { value = value.value }))
      end
      local values_menu = Menu({
        relative = "editor",
        position = "50%",
        size = { width = 64, height = math.min(#value_lines + 2, 20) },
        border = { style = "single", text = { top = " " .. (option.name or option.id) .. " ", top_align = "center" } },
      }, {
        lines = value_lines,
        keymap = {
          focus_next = { "j", "<Down>" },
          focus_prev = { "k", "<Up>" },
          close = { "<Esc>", "q" },
          submit = { "<CR>" },
        },
        on_submit = function(value_item)
          on_select(option, value_item.value)
        end,
      })
      values_menu:mount()
    end,
  })
  menu:mount()
end

function UI:close()
  if self.closed then
    return
  end
  self.closed = true
  self:_close_fold()
  if self.input then
    pcall(self.input.unmount, self.input)
    self.input = nil
  end
  if vim.api.nvim_buf_is_valid(self.transcript_buffer) then
    pcall(vim.api.nvim_buf_delete, self.transcript_buffer, { force = true })
  end
end

M.UI = UI

return M
