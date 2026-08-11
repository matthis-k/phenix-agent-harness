local M = {}

local UI = {}
UI.__index = UI

local transcript_namespace = vim.api.nvim_create_namespace("phenix-transcript")

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

local function content_text(content)
  if type(content) ~= "table" then
    return ""
  end
  if content.type == "text" then
    return content.text or ""
  end
  return ""
end

local function json_text(value)
  if value == nil then
    return nil
  end
  if type(value) == "string" then
    return value
  end
  local ok, encoded = pcall(vim.json.encode, value)
  return ok and encoded or vim.inspect(value)
end

local function tool_output_text(value)
  if value == nil then
    return nil
  end
  if type(value) == "table" then
    if type(value.summary) == "string" then
      return value.summary
    end
    if type(value.output) == "string" then
      return value.output
    end
  end
  return json_text(value)
end

local function append_text(lines, text)
  vim.list_extend(lines, split_text(text))
end

local function define_highlights()
  local links = {
    PhenixTranscriptUser = "Title",
    PhenixTranscriptAssistant = "Function",
    PhenixTranscriptThinking = "Comment",
    PhenixTranscriptTool = "Special",
    PhenixTranscriptSystem = "Statement",
    PhenixTranscriptError = "DiagnosticError",
  }
  for name, link in pairs(links) do
    pcall(vim.api.nvim_set_hl, 0, name, { default = true, link = link })
  end
end

function M.new(options)
  options = options or {}
  define_highlights()

  local transcript_buffer = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(transcript_buffer, "phenix://transcript/" .. tostring(transcript_buffer))
  configure_buffer(transcript_buffer, "markdown", false)
  pcall(vim.treesitter.start, transcript_buffer, "markdown")

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
    entries = {},
    entries_by_id = {},
    tool_entries = {},
    fold_ranges = {},
    active_stream = nil,
    next_entry_id = 1,
    on_submit = options.on_submit or function()
      return true
    end,
  }, UI)

  ui:_install_input_actions()
  return ui
end

function UI:_install_input_actions()
  local function submit(behavior)
    return function()
      self:submit_input(behavior)
    end
  end

  vim.keymap.set("n", "<CR>", submit("send"), {
    buffer = self.input_buffer,
    desc = "Phenix: send prompt",
  })
  vim.keymap.set("n", "<S-CR>", submit("steer"), {
    buffer = self.input_buffer,
    desc = "Phenix: steer current response",
  })
  vim.keymap.set("n", "<M-CR>", submit("follow_up"), {
    buffer = self.input_buffer,
    desc = "Phenix: queue follow-up",
  })

  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = self.input_buffer,
    callback = submit("send"),
    desc = "Phenix: send prompt when the prompt buffer is written",
  })
end

function UI:_next_id(prefix)
  local id = string.format("%s:%d", prefix, self.next_entry_id)
  self.next_entry_id = self.next_entry_id + 1
  return id
end

function UI:_append_entry(entry)
  entry.id = entry.id or self:_next_id(entry.kind)
  if entry.expanded == nil then
    entry.expanded = false
  end
  table.insert(self.entries, entry)
  self.entries_by_id[entry.id] = entry
  self.active_stream = nil
  self:_render()
  return entry
end

function UI:_append_stream(kind, text, message_id)
  if not text or text == "" then
    return
  end

  local key = kind .. ":" .. tostring(message_id or "")
  local entry = self.active_stream
  if not entry or entry.stream_key ~= key then
    entry = {
      id = self:_next_id(kind),
      kind = kind,
      text = "",
      stream_key = key,
      expanded = false,
    }
    table.insert(self.entries, entry)
    self.entries_by_id[entry.id] = entry
    self.active_stream = entry
  end
  entry.text = entry.text .. text
  self:_render()
end

function UI:append_user(text, label)
  text = vim.trim(text or "")
  if text == "" then
    return
  end
  self:_append_entry({
    kind = "user",
    label = label or "You",
    text = text,
  })
end

function UI:append_assistant(text, message_id)
  self:_append_stream("assistant", text, message_id)
end

function UI:append_thinking(text, message_id)
  self:_append_stream("thinking", text, message_id)
end

function UI:finish_response()
  self.active_stream = nil
end

function UI:append_error(message)
  self:_append_entry({
    kind = "error",
    text = tostring(message),
  })
end

function UI:_tool(update)
  local tool_call_id = update.toolCallId or update.tool_call_id
  if not tool_call_id then
    return nil
  end

  local id = "tool:" .. tostring(tool_call_id)
  local entry = self.tool_entries[id]
  if not entry then
    entry = {
      id = id,
      kind = "tool",
      title = tostring(update.title or tool_call_id),
      status = update.status or "pending",
      expanded = false,
    }
    self.tool_entries[id] = entry
    self.entries_by_id[id] = entry
    table.insert(self.entries, entry)
  end

  local fields = update.fields or update
  entry.title = tostring(fields.title or update.title or entry.title)
  entry.status = fields.status or update.status or entry.status
  if fields.rawInput ~= nil or fields.raw_input ~= nil or update.rawInput ~= nil or update.raw_input ~= nil then
    entry.input = json_text(fields.rawInput or fields.raw_input or update.rawInput or update.raw_input)
  end
  if fields.rawOutput ~= nil or fields.raw_output ~= nil or update.rawOutput ~= nil or update.raw_output ~= nil then
    entry.output = tool_output_text(fields.rawOutput or fields.raw_output or update.rawOutput or update.raw_output)
  end
  self.active_stream = nil
  return entry
end

function UI:append_update(update)
  if not update then
    return
  end

  local kind = update.sessionUpdate or update.session_update
  if kind == "agent_message_chunk" then
    self:append_assistant(content_text(update.content), update.messageId or update.message_id)
  elseif kind == "agent_thought_chunk" then
    self:append_thinking(content_text(update.content), update.messageId or update.message_id)
  elseif kind == "tool_call" or kind == "tool_call_update" then
    if self:_tool(update) then
      self:_render()
    end
  elseif kind == "plan" then
    self:_append_entry({
      kind = "system",
      label = "Plan",
      text = json_text(update.entries or update.plan or update),
    })
  end
end

function UI:_capture_fold_state()
  if not self.transcript_window or not vim.api.nvim_win_is_valid(self.transcript_window) then
    return
  end

  for id, range in pairs(self.fold_ranges) do
    local entry = self.entries_by_id[id]
    if entry then
      local closed = vim.api.nvim_win_call(self.transcript_window, function()
        return vim.fn.foldclosed(range.start_line)
      end)
      entry.expanded = closed == -1
    end
  end
end

function UI:_render()
  self:_capture_fold_state()

  local lines = {}
  local highlights = {}
  local fold_ranges = {}

  local function heading(text, highlight)
    local line = #lines + 1
    table.insert(lines, text)
    table.insert(highlights, { line = line, group = highlight })
    table.insert(lines, "")
    return line
  end

  for _, entry in ipairs(self.entries) do
    if #lines > 0 then
      table.insert(lines, "")
    end

    if entry.kind == "user" then
      heading("## " .. (entry.label or "You"), "PhenixTranscriptUser")
      append_text(lines, entry.text)
    elseif entry.kind == "assistant" then
      heading("## Phenix", "PhenixTranscriptAssistant")
      append_text(lines, entry.text)
    elseif entry.kind == "thinking" then
      local header = heading("### Thinking", "PhenixTranscriptThinking")
      local start_line = header + 2
      append_text(lines, entry.text)
      if #lines >= start_line then
        fold_ranges[entry.id] = {
          start_line = start_line,
          end_line = #lines,
          expanded = entry.expanded,
        }
      end
    elseif entry.kind == "tool" then
      local status = entry.status and (" · " .. tostring(entry.status)) or ""
      local header = heading("### Tool · " .. (entry.title or "tool") .. status, "PhenixTranscriptTool")
      local start_line = header + 2
      if entry.input and entry.input ~= "" then
        table.insert(lines, "**Input**")
        table.insert(lines, "```json")
        append_text(lines, entry.input)
        table.insert(lines, "```")
      end
      if entry.output and entry.output ~= "" then
        if #lines >= start_line then
          table.insert(lines, "")
        end
        table.insert(lines, "**Output**")
        table.insert(lines, "```text")
        append_text(lines, entry.output)
        table.insert(lines, "```")
      end
      if #lines >= start_line then
        fold_ranges[entry.id] = {
          start_line = start_line,
          end_line = #lines,
          expanded = entry.expanded,
        }
      end
    elseif entry.kind == "system" then
      heading("### " .. (entry.label or "System"), "PhenixTranscriptSystem")
      append_text(lines, entry.text or "")
    elseif entry.kind == "error" then
      heading("### Error", "PhenixTranscriptError")
      append_text(lines, entry.text or "")
    end
  end

  vim.api.nvim_set_option_value("modifiable", true, { buf = self.transcript_buffer })
  vim.api.nvim_buf_set_lines(self.transcript_buffer, 0, -1, false, lines)
  vim.api.nvim_buf_clear_namespace(self.transcript_buffer, transcript_namespace, 0, -1)
  for _, mark in ipairs(highlights) do
    vim.api.nvim_buf_set_extmark(self.transcript_buffer, transcript_namespace, mark.line - 1, 0, {
      line_hl_group = mark.group,
    })
  end
  vim.api.nvim_set_option_value("modifiable", false, { buf = self.transcript_buffer })

  self.fold_ranges = fold_ranges
  self:_apply_folds()
  self:follow()
end

function UI:_apply_folds()
  if not self.transcript_window or not vim.api.nvim_win_is_valid(self.transcript_window) then
    return
  end

  local ranges = {}
  for _, range in pairs(self.fold_ranges) do
    table.insert(ranges, range)
  end
  table.sort(ranges, function(left, right)
    return left.start_line < right.start_line
  end)

  vim.api.nvim_win_call(self.transcript_window, function()
    vim.cmd("silent! normal! zE")
    for _, range in ipairs(ranges) do
      if range.end_line >= range.start_line then
        vim.cmd(string.format("silent! %d,%dfold", range.start_line, range.end_line))
      end
    end
    for _, range in ipairs(ranges) do
      if not range.expanded then
        vim.cmd(string.format("silent! %dfoldclose", range.start_line))
      end
    end
  end)
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

function UI:submit_input(behavior)
  local lines = vim.api.nvim_buf_get_lines(self.input_buffer, 0, -1, false)
  local text = vim.trim(table.concat(lines, "\n"))
  if text == "" then
    return false
  end

  if self.on_submit(text, behavior or "send") == false then
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
  vim.api.nvim_set_option_value("foldmethod", "manual", { win = self.transcript_window })
  vim.api.nvim_set_option_value("foldenable", true, { win = self.transcript_window })

  vim.cmd("belowright " .. tostring(self.input_height) .. "split")
  self.input_window = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(self.input_window, self.input_buffer)
  vim.api.nvim_set_option_value("winfixheight", true, { win = self.input_window })
  vim.api.nvim_set_option_value("wrap", true, { win = self.input_window })
  vim.api.nvim_set_option_value("linebreak", true, { win = self.input_window })

  self:_apply_folds()
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
