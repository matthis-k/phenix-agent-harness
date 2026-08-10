local fixture = assert(vim.env.PHENIX_TEST_FIXTURE, "PHENIX_TEST_FIXTURE is required")
local python = assert(vim.env.PHENIX_TEST_PYTHON, "PHENIX_TEST_PYTHON is required")
local config_file = vim.env.PHENIX_TEST_CONFIG

if config_file and config_file ~= "" then
  local configuration = require("phenix.config").load(config_file):params()
  assert(configuration.input.definition_id == "phenix.harness")
  assert(configuration.input.router == "router.mixed")
  assert(#configuration.input.backends > 0)
  assert(#configuration.input.definitions > 0)
end

local phenix = require("phenix")
phenix.setup({
  conductor_command = { python, fixture },
  conductor_cwd_arg = false,
  config = false,
})

local session = phenix.open({ cwd = vim.fn.getcwd() })
assert(vim.wait(5000, function()
  return session:is_ready()
end, 20), "Phenix ACP fixture session did not become ready")

assert(session.session_id == "fixture-session")
assert(session.config_options[1].currentValue == "fixture-model")

session:set_config_option(session.config_options[1], "other-model")
assert(vim.wait(5000, function()
  return session.config_options[1] and session.config_options[1].currentValue == "other-model"
end, 20), "session config option did not update")

assert(session:prompt("hello from neovim"))
assert(vim.wait(5000, function()
  return not session.prompting and session.ui:text():find("echo: hello from neovim", 1, true) ~= nil
end, 20), "streamed ACP response did not reach the transcript")

local transcript = session.ui:text()
assert(transcript:find("### Thinking", 1, true), "thinking stream was not rendered")
assert(transcript:find("thinking about: hello from neovim", 1, true), "thinking content was not streamed")
assert(transcript:find("### Assistant", 1, true), "assistant stream was not rendered")

session.ui:follow()
assert(session:prompt("scroll while streaming"))
assert(vim.wait(5000, function()
  return session.prompting and session.ui:text():find("thinking about: scroll while streaming", 1, true) ~= nil
end, 10), "second prompt did not begin streaming")

vim.api.nvim_win_set_cursor(session.ui.transcript_window, { 1, 0 })
assert(vim.wait(5000, function()
  return not session.prompting and session.ui:text():find("echo: scroll while streaming", 1, true) ~= nil
end, 10), "second prompt did not finish streaming")
assert(
  vim.api.nvim_win_get_cursor(session.ui.transcript_window)[1] == 1,
  "streaming output moved the transcript cursor after the user navigated away from the tail"
)

phenix.close()
vim.wait(1000, function()
  return session.client.stopped
end, 20)
