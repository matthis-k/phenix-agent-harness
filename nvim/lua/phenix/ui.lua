local M = {}

local UI = {}
UI.__index = UI

local function configure_buffer(buffer, filetype, modifiable, buftype)
  vim.api.nvim_set_option_value("buftype", buftype or "nofile", { buf = buffer })
  vim.api.nvim_set_option_value("bufhidden", "hide", { buf = buffer })
  vim.api.nvim_set_option_value("swapfile", false, { buf = buffer })
  vim.api.nvim_set_option_value("filetype", filetype, { buf = buffer })
  vim.api.nvim_set_option_value("modifiable", modifiable, { buf = buffer })
end

local function split_text(text)
  return vim.split(text or "", "\n", { plain = true })
end

function M.new(options)
  options = options or {}

  local transcript_buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(transcript_buffer, "phenix://transcript/" .. tostring(transcript_buffer))
  configure_buffer(transcript_buffer, "text", false)

  local input_buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(input_buffer, "phenix://prompt/" .. tostring(input_buffer))
  configure_buffer(input_buffer, "text", true, "acwrite")
  vim.api.nvim_buf_set_lines(input_buffer, 0, -1, false, { "" })
  vim.api.nvim_set_option_value("modified", false, { buf = input_buffer })

  local ui = setmetatable({
    transcript_buffer = transcript_buffer,
    input_buffer = input_buffer,
    transcript_window = nil,
    input_window = nil,
    width = options.width or 48,
    input_height = options.input_height or 4,
    assistant_active = false,
    on_submit = options.on_submit or function()
      return true
    end,
  }, UI)

  ui:_install_input_actions()
  return ui
end

function UI:_install_input_actions()
  local function submit()
    self:submit_input()
  end

  vim.keymap.set("i", "<CR>", submit, {
    buffer = self.input_buffer,
    desc = "Phenix: send prompt",
  })
  vim.keymap.set("n", "<CR>", submit, {
    buffer = self.input_buffer,
    desc = "Phenix: send prompt",
  })

  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = self.input_buffer,
    callback = submit,
    desc = "Phenix: send prompt when the prompt buffer is written",
  })
end

function UI:_append_lines(lines)
  if #lines == 0 then
    return
  end
  vim.api.nvim_set_option_value("modifiable", true, { buf = self.transcript_buffer })
  vim.api.nvim_buf_set_lines(self.transcript_buffer, -1, -1, false, lines)
  vim.api.nvim_set_option_value("modifiable", false, { buf = self.transcript_buffer })
  self:follow()
end

function UI:_append_to_last_line(text)
  local chunks = split_text(text)
  local count = vim.api.nvim_buf_line_count(self.transcript_buffer)
  local current = vim.api.nvim_buf_get_lines(self.transcript_buffer, count - 1, count, false)[1] or ""

  vim.api.nvim_set_option_value("modifiable", true, { buf = self.transcript_buffer })
  vim.api.nvim_buf_set_lines(self.transcript_buffer, count - 1, count, false, { current .. (chunks[1] or "") })
  if #chunks > 1 then
    vim.api.nvim_buf_set_lines(self.transcript_buffer, -1, -1, false, vim.list_slice(chunks, 2))
  end
  vim.api.nvim_set_option_value("modifiable", false, { buf = self.transcript_buffer })
  self:follow()
end

function UI:append_user(text)
  self.assistant_active = false
  local lines = split_text(text)
  if #lines == 0 then
    return
  end
  lines[1] = "You: " .. lines[1]
  self:_append_lines(vim.list_extend({ "" }, lines))
end

function UI:append_assistant(text)
  if not text or text == "" then
    return
  end
  if not self.assistant_active then
    self.assistant_active = true
    self:_append_lines({ "", "Phenix: " })
  end
  self:_append_to_last_line(text)
end

function UI:finish_response()
  self.assistant_active = false
end

function UI:append_error(message)
  self.assistant_active = false
  self:_append_lines({ "", "Error: " .. tostring(message) })
end

function UI:append_update(update)
  if not update or update.sessionUpdate ~= "agent_message_chunk" then
    return
  end
  local content = update.content or {}
  self:append_assistant(content.text or "")
end

function UI:text()
  return table.concat(vim.api.nvim_buf_get_lines(self.transcript_buffer, 0, -1, false), "\n")
end

function UI:is_visible()
  return self.transcript_window ~= nil
    and self.input_window ~= nil
    and vim.api.nvim_win_is_valid(self.transcript_window)
    and vim.api.nvim_win_is_valid(self.input_window)
end

function UI:follow()
  if not self:is_visible() then
    return
  end
  local count = vim.api.nvim_buf_line_count(self.transcript_buffer)
  vim.api.nvim_win_set_cursor(self.transcript_window, { math.max(count, 1), 0 })
end

function UI:focus_input()
  if not self:is_visible() then
    return
  end
  vim.api.nvim_set_current_win(self.input_window)
  vim.cmd("startinsert")
end

function UI:submit_input()
  local lines = vim.api.nvim_buf_get_lines(self.input_buffer, 0, -1, false)
  local text = vim.trim(table.concat(lines, "\n"))
  if text == "" then
    return false
  end

  if self.on_submit(text) == false then
    return false
  end

  vim.api.nvim_buf_set_lines(self.input_buffer, 0, -1, false, { "" })
  vim.api.nvim_set_option_value("modified", false, { buf = self.input_buffer })
  return true
end

function UI:mount()
  if self:is_visible() then
    self:focus_input()
    return
  end

  self:hide()

  vim.cmd("botright vsplit")
  self.transcript_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(self.transcript_window, self.transcript_buffer)
  vim.api.nvim_win_set_width(self.transcript_window, self.width)
  vim.api.nvim_set_option_value("winfixwidth", true, { win = self.transcript_window })
  vim.api.nvim_set_option_value("wrap", true, { win = self.transcript_window })
  vim.api.nvim_set_option_value("linebreak", true, { win = self.transcript_window })

  vim.cmd("belowright " .. tostring(self.input_height) .. "split")
  self.input_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(self.input_window, self.input_buffer)
  vim.api.nvim_set_option_value("winfixheight", true, { win = self.input_window })
  vim.api.nvim_set_option_value("wrap", true, { win = self.input_window })
  vim.api.nvim_set_option_value("linebreak", true, { win = self.input_window })

  self:follow()
  self:focus_input()
end

function UI:hide()
  local input_window = self.input_window
  local transcript_window = self.transcript_window
  self.input_window = nil
  self.transcript_window = nil

  if input_window and vim.api.nvim_win_is_valid(input_window) then
    pcall(vim.api.nvim_win_close, input_window, true)
  end
  if transcript_window and vim.api.nvim_win_is_valid(transcript_window) then
    pcall(vim.api.nvim_win_close, transcript_window, true)
  end
end

function UI:toggle()
  if self:is_visible() then
    self:hide()
  else
    self:mount()
  end
end

function UI:permission(params, respond)
  local options = params.options or {}
  if #options == 0 then
    respond(nil)
    return
  end

  vim.ui.select(options, {
    prompt = ((params.toolCall or {}).title) or "Phenix permission",
    format_item = function(option)
      return option.name or option.optionId or "permission"
    end,
  }, function(option)
    respond(option and option.optionId or nil)
  end)
end

function UI:close()
  self:hide()
  if vim.api.nvim_buf_is_valid(self.input_buffer) then
    pcall(vim.api.nvim_buf_delete, self.input_buffer, { force = true })
  end
  if vim.api.nvim_buf_is_valid(self.transcript_buffer) then
    pcall(vim.api.nvim_buf_delete, self.transcript_buffer, { force = true })
  end
end

M.UI = UI

return M
